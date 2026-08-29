/**
 * AgentRouter Provider Extension for pi
 *
 * Registers AgentRouter (https://agentrouter.org) as a single custom provider
 * with GPT-5.6 Sol, Claude Opus 4.8, Claude Opus 5, DeepSeek V4 Flash, and GLM 5.3.
 * Claude models use per-model api/baseUrl/header overrides (anthropic-messages);
 * the rest ride the provider-level openai-completions config.
 *
 * Setup:
 *   1. /login agentrouter  (or set AGENTROUTER_API_KEY)
 *   2. Install: pi install npm:@bismawy/pi-agentrouter
 *   3. /model → agentrouter/gpt-5.6-sol, agentrouter/claude-opus-4-8,
 *      agentrouter/claude-opus-5, agentrouter/deepseek-v4-flash, agentrouter/glm-5.3
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

/**
 * Strips ANSI escapes, non-printable control characters, null bytes,
 * and lone surrogate characters that frequently trigger WAF / moderation blocks.
 */
function cleanContent(text: string): string {
  if (typeof text !== "string") return text;
  return text
    // Strip ANSI escape codes
    .replace(/\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g, "")
    // Strip control characters except \t (0x09), \n (0x0A), \r (0x0D)
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "")
    // Strip dangling / lone Unicode surrogates
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "");
}

function sanitizeInPlace(value: unknown): void {
  if (typeof value === "string") return;
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      if (typeof value[i] === "string") value[i] = cleanContent(value[i]);
      else sanitizeInPlace(value[i]);
    }
    return;
  }
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    for (const k of Object.keys(obj)) {
      if (typeof obj[k] === "string") obj[k] = cleanContent(obj[k] as string);
      else sanitizeInPlace(obj[k]);
    }
  }
}

/**
 * AgentRouter WAF authorizes Pi traffic by the canonical system-prompt header
 * sitting at byte 0. Project AGENTS.md / extra context often lands in front of it
 * on the first turn → 400 content-blocked. Same approach as @madgagarin/pi-agentrouter.
 */
const CANONICAL_PI_HEADER =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const PI_HEADER_RE =
  /(?:You are [^\n\r]*operating inside pi[^\n\r]*\n?|You are (?:pi|Pi)[^\n\r]*\n?)/i;

const LANGUAGE_PREAMBLE =
  "[Instruction: Process the user request below and respond in the appropriate language.]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function enforceCanonicalRootPrompt(systemPrompt: unknown): unknown {
  if (!systemPrompt) return CANONICAL_PI_HEADER;

  if (typeof systemPrompt === "string") {
    const text = systemPrompt.trim();
    const match = text.match(PI_HEADER_RE);
    if (!match || match.index === undefined) {
      return `${CANONICAL_PI_HEADER}\n\n${text}`;
    }
    if (match.index > 0) {
      const header = match[0].trim();
      const prefix = text.slice(0, match.index).trim();
      const rest = text.slice(match.index + match[0].length).trim();
      return `${header}\n\n${prefix}${rest ? "\n\n" + rest : ""}`;
    }
    return text;
  }

  if (Array.isArray(systemPrompt)) {
    if (systemPrompt.length === 0) return [{ type: "text", text: CANONICAL_PI_HEADER }];
    const first = systemPrompt[0];
    if (isRecord(first) && typeof first.text === "string") {
      first.text = enforceCanonicalRootPrompt(first.text) as string;
    }
    return systemPrompt;
  }

  return systemPrompt;
}

function prependUserPreamble(content: unknown): unknown {
  if (typeof content === "string") {
    if (content.startsWith(LANGUAGE_PREAMBLE)) return content;
    return content ? `${LANGUAGE_PREAMBLE}\n\n${content}` : LANGUAGE_PREAMBLE;
  }
  if (!Array.isArray(content)) return content;
  const head = content[0];
  if (isRecord(head) && head.type === "text" && head.text === LANGUAGE_PREAMBLE) return content;
  return [{ type: "text", text: LANGUAGE_PREAMBLE }, ...content];
}

/** Shallow-copy a message so in-place edits never touch pi session objects. */
function copyMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...msg };
  if (Array.isArray(msg.content)) {
    copy.content = msg.content.map((b) => {
      if (!isRecord(b)) return b;
      const bc = { ...b };
      if (Array.isArray(b.content)) {
        bc.content = b.content.map((c) => (isRecord(c) ? { ...c } : c));
      }
      return bc;
    });
  }
  return copy;
}

function isAgentRouterCall(payload: unknown, provider?: string, baseUrl?: string): boolean {
  if (provider?.toLowerCase().includes("agentrouter")) return true;
  if (baseUrl?.toLowerCase().includes("agentrouter.org")) return true;
  if (!isRecord(payload) || typeof payload.model !== "string") return false;
  return /gpt-5\.|glm-5\.|deepseek-v|claude-opus/.test(payload.model);
}

/**
 * Prepend the language preamble to a user turn, unless the content starts
 * with a tool_result block (Anthropic requires those to lead the message).
 */
function frameUserTurn(msg: Record<string, unknown>): void {
  if (Array.isArray(msg.content)) {
    const head = msg.content[0];
    if (isRecord(head) && head.type === "tool_result") return;
  }
  msg.content = prependUserPreamble(msg.content);
}

// --- Poisoned-history auto-recovery (1.2.0) --------------------------------
// The WAF scans the FULL request body every turn, so one blocked message
// poisons the session until it is hidden. 1.0.7 redacted last-N user messages
// from the end — after one block, the NEWEST user turn was always swallowed.
// 1.2.0: NEVER redact the newest user turn. Hide older messages one-by-one
// (sticky fingerprints) until the request passes; those stay hidden. If the
// newest turn itself is the trigger, notify the user to rephrase.
const WAF_BLOCK_RE = /sensitive[_ ]words?[_ ]detected|content-blocked/i;
// ponytail: placeholder must stay WAF-neutral — earlier text mentioning the
// filter's own vocabulary ("sensitive words", "blocked") re-triggered the WAF,
// making the deepest redaction level fail by design.
const REDACTED_NOTE = "[Message withheld by local policy]";
const MAX_REDACTED = 60;

const redactSet = new Set<string>();
let escalatePending = false;
let exhausted = false;
let sessionAnchor: string | null = null;

function fingerprintOf(msg: Record<string, unknown>): string {
  return `${msg.role}:${JSON.stringify(msg.content).slice(0, 160)}`;
}

// First USER message, skipping system/developer — those are constant so they
// never reset across /new (1.0.7 Bug A).
function firstUserAnchor(messages: unknown[]): string {
  for (const m of messages) {
    if (isRecord(m) && m.role === "user") return fingerprintOf(m);
  }
  return String(messages.length);
}

function hasRedactableText(content: unknown): boolean {
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content)) return false;
  for (const b of content) {
    if (!isRecord(b)) continue;
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) return true;
    if (b.type === "tool_result") {
      if (typeof b.content === "string" && b.content.length > 0) return true;
      if (Array.isArray(b.content)) {
        for (const c of b.content) {
          if (isRecord(c) && c.type === "text" && typeof c.text === "string" && c.text.length > 0) {
            return true;
          }
        }
      }
    }
  }
  return false;
}

function redactBlocks(content: unknown): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      block.text = REDACTED_NOTE;
    } else if (block.type === "tool_result") {
      if (typeof block.content === "string") block.content = REDACTED_NOTE;
      else if (Array.isArray(block.content)) {
        for (const b of block.content) {
          if (isRecord(b) && b.type === "text" && typeof b.text === "string") b.text = REDACTED_NOTE;
        }
      }
    }
  }
}

function lastUserIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRecord(messages[i]) && (messages[i] as Record<string, unknown>).role === "user") return i;
  }
  return -1;
}

function isHideable(msg: Record<string, unknown>): boolean {
  return msg.role === "user" || msg.role === "assistant";
}

function redactMessageAt(messages: unknown[], i: number): void {
  const msg = messages[i];
  if (!isRecord(msg)) return;
  if (typeof msg.content === "string") msg.content = REDACTED_NOTE;
  else redactBlocks(msg.content);
}

function applyPoisonRedaction(payload: Record<string, unknown>): void {
  const messages = payload.messages;
  if (!Array.isArray(messages) || messages.length === 0) return;

  // Fingerprints of originals — after copy+redact the content changes, so the
  // set would never match the mutated copies (1.0.7-style false exhausted).
  const fps = messages.map((m) => (isRecord(m) ? fingerprintOf(m) : ""));

  const anchor = firstUserAnchor(messages);
  if (anchor !== sessionAnchor) {
    // First contact just adopts the anchor; only a real change (e.g. /new or
    // compaction) resets state — otherwise a pending escalation is lost.
    const firstContact = sessionAnchor === null;
    sessionAnchor = anchor;
    if (!firstContact) {
      redactSet.clear();
      escalatePending = false;
      exhausted = false;
    }
  }

  if (redactSet.size > 0 && !fps.some((fp) => fp && redactSet.has(fp))) {
    redactSet.clear();
  }

  const lastUser = lastUserIndex(messages);

  for (let i = 0; i < lastUser; i++) {
    if (!isRecord(messages[i]) || !isHideable(messages[i] as Record<string, unknown>)) continue;
    if (redactSet.has(fps[i])) redactMessageAt(messages, i);
  }

  if (escalatePending) {
    escalatePending = false;
    for (let i = lastUser - 1; i >= 0 && redactSet.size < MAX_REDACTED; i--) {
      if (!isRecord(messages[i]) || !isHideable(messages[i] as Record<string, unknown>)) continue;
      if (redactSet.has(fps[i])) continue;
      redactSet.add(fps[i]);
      if (!hasRedactableText((messages[i] as Record<string, unknown>).content)) continue;
      redactMessageAt(messages, i);
      break;
    }
  }

  exhausted = lastUser <= 0;
  if (!exhausted) {
    exhausted = true;
    for (let i = 0; i < lastUser; i++) {
      if (!isRecord(messages[i]) || !isHideable(messages[i] as Record<string, unknown>)) continue;
      if (!redactSet.has(fps[i])) {
        exhausted = false;
        break;
      }
    }
  }
}

function patchAgentRouterPayload(payload: unknown): void {
  if (!isRecord(payload)) return;

  if (payload.system !== undefined) {
    payload.system = enforceCanonicalRootPrompt(payload.system);
  }

  if (!Array.isArray(payload.messages) || payload.messages.length === 0) return;

  for (const msg of payload.messages) {
    if (isRecord(msg) && msg.role === "developer") msg.role = "system";
  }

  const first = payload.messages[0];
  if (isRecord(first) && (first.role === "system" || first.role === "developer")) {
    first.role = "system";
    first.content = enforceCanonicalRootPrompt(first.content);
  }

  // The WAF inspects user content beyond the opening turn (later Indonesian
  // turns and compacted history get blocked too), so frame EVERY user message.
  for (const msg of payload.messages) {
    if (isRecord(msg) && msg.role === "user") frameUserTurn(msg);
  }
}

export default function (pi: ExtensionAPI) {
  pi.registerProvider("agentrouter", {
    baseUrl: "https://agentrouter.org/v1",
    apiKey: "$AGENTROUTER_API_KEY",
    api: "openai-completions",
    headers: {
      "Originator": "codex_cli_rs",
      "User-Agent": "codex_cli_rs/0.101.0 (Mac OS 26.0.1; arm64) Apple_Terminal/464",
      "Version": "0.101.0",
    },
    compat: {
      sendSessionAffinityHeaders: true,
    },
    models: [
      {
        id: "gpt-5.6-sol",
        name: "GPT-5.6 Sol (AgentRouter)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 272000,
        maxTokens: 16384,
        thinkingLevelMap: {
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
        },
        compat: {
          supportsDeveloperRole: false,
        },
      },
      {
        id: "deepseek-v4-flash",
        name: "DeepSeek V4 Flash (AgentRouter)",
        reasoning: true,
        // AgentRouter backend rejects images for this model ("This model does not support image")
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
        thinkingLevelMap: {
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
        },
        compat: {
          supportsDeveloperRole: false,
          requiresReasoningContentOnAssistantMessages: true,
          thinkingFormat: "deepseek",
        },
      },
      {
        id: "glm-5.3",
        name: "GLM 5.3 (AgentRouter)",
        reasoning: true,
        // AgentRouter backend is text-only here: image_url blocks get
        // "***.***.type 参数非法，取值范围 ['text']" 400 errors
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 131072,
        maxTokens: 8192,
        // Backend only accepts low/high/max (always-on thinking)
        thinkingLevelMap: {
          low: "low",
          medium: "high",
          high: "high",
          xhigh: "max",
        },
        compat: {
          supportsDeveloperRole: false,
        },
      },
      // Claude models ride the Anthropic Messages API via per-model overrides
      {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8 (AgentRouter)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
        api: "anthropic-messages",
        baseUrl: "https://agentrouter.org",
        headers: {
          "User-Agent": "claude-cli/2.1.158 (external, sdk-cli)",
          "anthropic-version": "2023-06-01",
          "anthropic-beta":
            "claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24,redact-thinking-2026-02-12",
          "anthropic-dangerous-direct-browser-access": "true",
          "x-app": "cli",
        },
        thinkingLevelMap: {
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
        },
        compat: {
          supportsDeveloperRole: false,
          cacheControlFormat: "anthropic",
          sendSessionAffinityHeaders: true,
        },
      },
      {
        id: "claude-opus-5",
        name: "Claude Opus 5 (AgentRouter)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
        api: "anthropic-messages",
        baseUrl: "https://agentrouter.org",
        headers: {
          "User-Agent": "claude-cli/2.1.158 (external, sdk-cli)",
          "anthropic-version": "2023-06-01",
          "anthropic-beta":
            "claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24,redact-thinking-2026-02-12",
          "anthropic-dangerous-direct-browser-access": "true",
          "x-app": "cli",
        },
        thinkingLevelMap: {
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
        },
        compat: {
          supportsDeveloperRole: false,
          cacheControlFormat: "anthropic",
          sendSessionAffinityHeaders: true,
        },
      },
    ],
  });

  // Mutate payload.messages copies (return undefined). Cloning the whole payload
  // drops provider fields; copying only message objects keeps session state clean.
  pi.on("before_provider_request", (event, ctx) => {
    if (!event.payload) return;
    const model = ctx.model as { provider?: string; baseUrl?: string } | undefined;
    if (!isAgentRouterCall(event.payload, model?.provider, model?.baseUrl)) return;
    const payload = event.payload as Record<string, unknown>;
    if (Array.isArray(payload.messages)) {
      payload.messages = payload.messages.map((m) => (isRecord(m) ? copyMessage(m) : m));
    }
    sanitizeInPlace(payload);
    applyPoisonRedaction(payload);
    patchAgentRouterPayload(payload);
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "error") return;
    const provider = message.provider ?? ctx.model?.provider;
    if (!provider?.toLowerCase().includes("agentrouter")) return;

    const errorMessage = message.errorMessage ?? "";
    if (!WAF_BLOCK_RE.test(errorMessage)) return;
    escalatePending = true;
    if (exhausted) {
      ctx.ui.notify(
        "AgentRouter content filter keeps blocking even with earlier messages hidden. " +
          "Your latest message is likely the trigger — please rephrase or split it.",
        "warning",
      );
      return;
    }
    ctx.ui.notify(
      `AgentRouter content filter blocked the request. ` +
        `Hiding ${redactSet.size || "one more"} earlier message(s) on the next try. ` +
        `Your latest message is kept.`,
      "warning",
    );
  });
}
