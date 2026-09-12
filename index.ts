/**
 * AgentRouter Provider Extension for pi
 *
 * Registers AgentRouter (https://agentrouter.org) as a single custom provider
 * with GPT-6 Astra, GPT-5.6 Sol, Claude Opus 4.8, Claude Opus 5, DeepSeek V4 Flash, and GLM 5.3.
 * GPT-6 Astra uses openai-responses; Claude models use anthropic-messages;
 * the rest ride the provider-level openai-completions config.
 *
 * Setup:
 *   1. /login agentrouter  (or set AGENTROUTER_API_KEY)
 *   2. Install: pi install npm:@bismawy/pi-agentrouter
 *   3. /model → agentrouter/gpt-6-astra, agentrouter/gpt-5.6-sol, agentrouter/claude-opus-4-8,
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
  "[Instruction: You are an expert coding assistant operating inside pi. Please carefully analyze the technical context, understand the user request, follow all project instructions and coding standards, and respond thoroughly in the requested language.]";

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function enforceCanonicalRootPrompt(systemPrompt: unknown, textType = "text"): unknown {
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
    if (systemPrompt.length === 0) return [{ type: textType, text: CANONICAL_PI_HEADER }];
    const first = systemPrompt[0];
    if (isRecord(first) && typeof first.text === "string") {
      first.text = enforceCanonicalRootPrompt(first.text) as string;
    }
    return systemPrompt;
  }

  return systemPrompt;
}

function prependUserPreamble(content: unknown, textType = "text"): unknown {
  if (typeof content === "string") {
    if (content.startsWith(LANGUAGE_PREAMBLE)) return content;
    return content ? `${LANGUAGE_PREAMBLE}\n\n${content}` : LANGUAGE_PREAMBLE;
  }
  if (!Array.isArray(content)) return content;
  if (content.length === 0) return [{ type: textType, text: LANGUAGE_PREAMBLE }];
  const head = content[0];
  if (isRecord(head) && head.type === textType && typeof head.text === "string") {
    if (head.text.startsWith(LANGUAGE_PREAMBLE)) return content;
    head.text = `${LANGUAGE_PREAMBLE}\n\n${head.text}`;
    return content;
  }
  return [{ type: textType, text: LANGUAGE_PREAMBLE }, ...content];
}

function isAgentRouterCall(payload: unknown, provider?: string, baseUrl?: string): boolean {
  if (provider) return provider.toLowerCase().includes("agentrouter");
  if (baseUrl) return baseUrl.toLowerCase().includes("agentrouter.org");
  if (!isRecord(payload) || typeof payload.model !== "string") return false;
  return /gpt-5\.|gpt-6-astra|glm-5\.|deepseek-v|claude-opus/.test(payload.model);
}

/**
 * Prepend the language preamble to a user turn, unless the content starts
 * with a tool_result block (Anthropic requires those to lead the message).
 */
function frameUserTurn(msg: Record<string, unknown>, textType = "text"): void {
  if (Array.isArray(msg.content)) {
    const head = msg.content[0];
    if (isRecord(head) && head.type === "tool_result") return;
  }
  msg.content = prependUserPreamble(msg.content, textType);
}

// --- Poisoned-history auto-recovery (1.3.0) --------------------------------
// The WAF scans the FULL request body every turn, and cumulative non-English
// user tokens trip `400 content-blocked`. 1.0.7 redacted last-N user messages
// from the end; 1.2.2 escalated 1->2->4 messages (exhausting pi's 3 retries
// on sessions with >7 messages).
// 1.3.0: NEVER redact the newest user turn. On escalation:
//   Stage 1: Redact ALL older user turns in one shot (primary WAF trigger).
//   Stage 2: Redact ALL older assistant turns if needed.
// Fingerprints stay sticky across subsequent turns in the same session.
const WAF_BLOCK_RE = /sensitive[_ ]words?[_ ]detected|content-blocked/i;
const SENSITIVE_WORDS_RE = /sensitive[_ ]words?[_ ]detected/i;
// Keep the placeholder WAF-neutral; wording about the filter previously
// triggered additional content-filter rejections.
const REDACTED_NOTE = "[Message withheld by local policy]";

const redactSet = new Set<string>();
let escalatePending = false;
let isSensitiveBlock = false;
let exhausted = false;
let sessionAnchor: string | null = null;
let wafNotified = false;

function fingerprintOf(msg: Record<string, unknown>): string {
  const tc = Array.isArray(msg.tool_calls) ? JSON.stringify(msg.tool_calls).slice(0, 80) : "";
  // Responses function/reasoning/reference items have no content or role.
  if (msg.type === "function_call" || msg.type === "function_call_output") {
    return `${msg.type}:${msg.call_id}:${JSON.stringify(msg.arguments ?? msg.output ?? "").slice(0, 160)}`;
  }
  return `${msg.role ?? msg.type}:${JSON.stringify(msg.content ?? "").slice(0, 160)}:${tc}`;
}

// First USER message, skipping system/developer — those are constant so they
// never reset across /new (1.0.7 Bug A).
function firstUserAnchor(messages: unknown[]): string {
  for (const m of messages) {
    if (isRecord(m) && m.role === "user") return fingerprintOf(m);
  }
  return String(messages.length);
}

function isTextBlock(block: Record<string, unknown>): boolean {
  return block.type === "text" || block.type === "input_text" || block.type === "output_text";
}

function hasRedactableText(content: unknown, msg?: Record<string, unknown>): boolean {
  if (msg?.type === "function_call") return typeof msg.arguments === "string" && msg.arguments !== "{}";
  if (msg?.type === "function_call_output") return hasRedactableText(msg.output);
  if (typeof content === "string") return content.length > 0 && content !== REDACTED_NOTE;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!isRecord(b)) continue;
      if (isTextBlock(b) && typeof b.text === "string" && b.text.length > 0 && b.text !== REDACTED_NOTE) return true;
      if (b.type === "tool_result") {
        if (typeof b.content === "string" && b.content.length > 0 && b.content !== REDACTED_NOTE) return true;
        if (Array.isArray(b.content)) {
          for (const c of b.content) {
            if (isRecord(c) && isTextBlock(c) && typeof c.text === "string" && c.text.length > 0 && c.text !== REDACTED_NOTE) {
              return true;
            }
          }
        }
      }
    }
  }
  if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      if (isRecord(tc) && isRecord(tc.function) && typeof tc.function.arguments === "string" && tc.function.arguments !== "{}") {
        return true;
      }
    }
  }
  return false;
}

function redactBlocks(content: unknown): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecord(block)) continue;
    if (isTextBlock(block) && typeof block.text === "string") {
      block.text = REDACTED_NOTE;
    } else if (block.type === "tool_result") {
      if (typeof block.content === "string") block.content = REDACTED_NOTE;
      else if (Array.isArray(block.content)) {
        for (const b of block.content) {
          if (isRecord(b) && isTextBlock(b) && typeof b.text === "string") b.text = REDACTED_NOTE;
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
  return msg.role === "user" || msg.role === "assistant" || msg.role === "tool"
    || msg.type === "function_call" || msg.type === "function_call_output";
}

function redactMessageAt(messages: unknown[], i: number): void {
  const msg = messages[i];
  if (!isRecord(msg)) return;
  if (msg.type === "function_call") {
    msg.arguments = "{}";
    return;
  }
  if (msg.type === "function_call_output") {
    if (typeof msg.output === "string") msg.output = REDACTED_NOTE;
    else redactBlocks(msg.output);
    return;
  }
  if (typeof msg.content === "string") {
    msg.content = REDACTED_NOTE;
  } else if (Array.isArray(msg.content)) {
    redactBlocks(msg.content);
  } else if (msg.role === "tool" || msg.role === "assistant") {
    msg.content = REDACTED_NOTE;
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (isRecord(tc) && isRecord(tc.function) && typeof tc.function.arguments === "string") {
        tc.function.arguments = "{}";
      }
    }
  }
}

function applyPoisonRedaction(payload: Record<string, unknown>): void {
  const messages = Array.isArray(payload.messages) ? payload.messages : payload.input;
  if (!Array.isArray(messages) || messages.length === 0) return;

  // Prune failed assistant messages carrying error status/text in-place so dead error turns do not linger
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isRecord(m)) continue;
    if (m.role === "assistant") {
      if ((m as Record<string, unknown>).stopReason === "error") {
        messages.splice(i, 1);
      } else if (typeof m.content === "string" && WAF_BLOCK_RE.test(m.content)) {
        messages.splice(i, 1);
      }
    }
  }

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
      isSensitiveBlock = false;
      exhausted = false;
      wafNotified = false;
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
    const sensitive = isSensitiveBlock;
    isSensitiveBlock = false;

    if (sensitive) {
      // Sensitive words detected: neutralize ALL older turns (user, tool, assistant) in one shot
      for (let i = 0; i < lastUser; i++) {
        if (!isRecord(messages[i])) continue;
        const m = messages[i] as Record<string, unknown>;
        if (!isHideable(m)) continue;
        redactSet.add(fps[i]);
        if (hasRedactableText(m.content, m)) {
          redactMessageAt(messages, i);
        }
      }
    } else {
      // Language ratio block: Stage 1 user, Stage 2 assistant & tool
      let anyRedacted = false;
      for (let i = 0; i < lastUser; i++) {
        if (!isRecord(messages[i])) continue;
        const m = messages[i] as Record<string, unknown>;
        if (m.role !== "user") continue;
        if (redactSet.has(fps[i])) continue;
        redactSet.add(fps[i]);
        if (hasRedactableText(m.content, m)) {
          redactMessageAt(messages, i);
          anyRedacted = true;
        }
      }
      if (!anyRedacted) {
        for (let i = 0; i < lastUser; i++) {
          if (!isRecord(messages[i])) continue;
          const m = messages[i] as Record<string, unknown>;
          if (!isHideable(m) || m.role === "user") continue;
          if (redactSet.has(fps[i])) continue;
          redactSet.add(fps[i]);
          if (hasRedactableText(m.content, m)) {
            redactMessageAt(messages, i);
            anyRedacted = true;
          }
        }
      }
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

  const textType = Array.isArray(payload.messages) ? "text" : "input_text";
  if (payload.instructions !== undefined) {
    payload.instructions = enforceCanonicalRootPrompt(payload.instructions, textType);
  }
  if (typeof payload.input === "string") payload.input = prependUserPreamble(payload.input, textType);
  const messages = Array.isArray(payload.messages) ? payload.messages : payload.input;
  if (!Array.isArray(messages) || messages.length === 0) return;

  for (const msg of messages) {
    if (isRecord(msg) && msg.role === "developer") msg.role = "system";
  }

  const first = messages[0];
  if (isRecord(first) && (first.role === "system" || first.role === "developer")) {
    first.role = "system";
    first.content = enforceCanonicalRootPrompt(first.content, textType);
  }

  // The WAF inspects user content beyond the opening turn (later Indonesian
  // turns and compacted history get blocked too), so frame EVERY user message.
  for (const msg of messages) {
    if (isRecord(msg) && msg.role === "user") frameUserTurn(msg, textType);
  }
}

/**
 * pi reads `compat` from the MODEL entry only — provider-level compat is ignored
 * for extension-registered providers (it is merged only for models.json).
 * Single source of truth, spread into every model below.
 *
 * Declared in full so this provider works without pi-auto-compat:
 * - sendSessionAffinityHeaders defaults to false — on openai-completions it is the
 *   only reason prompt-cache affinity headers get sent at all.
 * - supportsLongCacheRetention is detection-based on openai-completions; pinning it
 *   matches what pi-auto-compat would otherwise inject via modelOverrides.
 */
const AGENTROUTER_COMPAT = {
  supportsDeveloperRole: false,
  sendSessionAffinityHeaders: true,
  supportsLongCacheRetention: true,
} as const;

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
    models: [
      {
        id: "gpt-6-astra",
        name: "GPT-6 Astra (AgentRouter)",
        // Chat Completions rejects function tools with reasoning for this model.
        api: "openai-responses",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        // Provisional limits based on GPT-5.6 Sol; update when AgentRouter confirms Astra's limits.
        contextWindow: 272000,
        maxTokens: 16384,
        thinkingLevelMap: {
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
        },
        compat: { ...AGENTROUTER_COMPAT },
      },
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
        compat: { ...AGENTROUTER_COMPAT },
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
          ...AGENTROUTER_COMPAT,
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
        compat: { ...AGENTROUTER_COMPAT },
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
          ...AGENTROUTER_COMPAT,
          cacheControlFormat: "anthropic",
          // pi ships adaptive thinking in the metadata of real Claude models; on a
          // proxy model it must be declared or pi falls back to budget thinking.
          forceAdaptiveThinking: true,
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
          ...AGENTROUTER_COMPAT,
          cacheControlFormat: "anthropic",
          forceAdaptiveThinking: true,
        },
      },
    ],
  });

  // Prune broken error messages from context so failed turns don't pollute future turns
  pi.on("context", (event, ctx) => {
    const provider = ctx.model?.provider;
    if (provider && !provider.toLowerCase().includes("agentrouter")) return;
    const filtered = event.messages.filter((m) => {
      if (m.role === "assistant" && m.stopReason === "error") return false;
      return true;
    });
    if (filtered.length !== event.messages.length) {
      return { messages: filtered };
    }
  });

  // Clone message trees, including nested tool calls, before sanitizing/redacting.
  pi.on("before_provider_request", (event, ctx) => {

    if (!event.payload) return;
    const model = ctx.model as { provider?: string; baseUrl?: string } | undefined;
    if (!isAgentRouterCall(event.payload, model?.provider, model?.baseUrl)) return;
    const payload = event.payload as Record<string, unknown>;
    if (Array.isArray(payload.messages)) payload.messages = structuredClone(payload.messages);
    if (Array.isArray(payload.input)) payload.input = structuredClone(payload.input);
    if (Array.isArray(payload.system)) payload.system = structuredClone(payload.system);
    sanitizeInPlace(payload);
    applyPoisonRedaction(payload);
    patchAgentRouterPayload(payload);
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role === "assistant" && message.stopReason !== "error") {
      wafNotified = false;
      isSensitiveBlock = false;
    }
    if (message.role !== "assistant" || message.stopReason !== "error") return;
    const provider = message.provider ?? ctx.model?.provider;
    if (!provider?.toLowerCase().includes("agentrouter")) return;

    const errorMessage = message.errorMessage ?? "";
    if (!WAF_BLOCK_RE.test(errorMessage)) return;
    escalatePending = true;
    if (SENSITIVE_WORDS_RE.test(errorMessage)) {
      isSensitiveBlock = true;
    }
    if (exhausted) {
      if (!wafNotified) {
        wafNotified = true;
        ctx.ui.notify(
          "AgentRouter content filter keeps blocking even with earlier messages hidden. " +
            "Your latest message is likely the trigger — please rephrase (e.g. in English) or split it.",
          "warning",
        );
      }
      return;
    }
    if (!wafNotified) {
      wafNotified = true;
      const note = isSensitiveBlock
        ? "Sensitive words detected in agent activity. Neutralizing previous leftovers so subsequent chats can proceed safely."
        : "AgentRouter content filter blocked the request. Retrying automatically with earlier messages hidden.";
      ctx.ui.notify(note, "warning");
    }
    // Mark the error as retryable so pi auto-restarts the turn: pi's retry
    // classifier (pi-ai isRetryableAssistantError) matches "provider returned
    // error". Each retry re-enters before_provider_request, which escalates
    // the redaction by one more message until the language-ratio WAF passes.
    return {
      message: {
        ...message,
        errorMessage: `${errorMessage} (provider returned error — retrying with earlier messages hidden)`,
      },
    };
  });
}
