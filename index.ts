/**
 * AgentRouter Provider Extension for pi
 *
 * Registers AgentRouter (https://agentrouter.org) as a custom provider
 * with GPT-5.6 Sol, Claude Opus 4.8, Claude Opus 5, DeepSeek V4 Flash, and GLM 5.3 models.
 *
 * Setup:
 *   1. Set AGENTROUTER_API_KEY environment variable
 *   2. Install: pi install npm:@bismawy/pi-agentrouter
 *   3. /model → select agentrouter/gpt-5.6-sol, agentrouter-anthropic/claude-opus-4-8,
 *      agentrouter-anthropic/claude-opus-5, agentrouter/deepseek-v4-flash, or agentrouter/glm-5.3
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
  content.unshift({ type: "text", text: LANGUAGE_PREAMBLE });
  return content;
}

function isAgentRouterCall(payload: unknown, provider?: string, baseUrl?: string): boolean {
  if (provider?.toLowerCase().includes("agentrouter")) return true;
  if (baseUrl?.toLowerCase().includes("agentrouter.org")) return true;
  if (!isRecord(payload) || typeof payload.model !== "string") return false;
  return /gpt-5\.|glm-5\.|deepseek-v|claude-opus/.test(payload.model);
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

  const firstUser = payload.messages.find(
    (m): m is Record<string, unknown> => isRecord(m) && m.role === "user",
  );
  if (firstUser) firstUser.content = prependUserPreamble(firstUser.content);
}

export default function (pi: ExtensionAPI) {
  // 1. OpenAI-compatible models (gpt-5.6-sol, deepseek-v4-flash, glm-5.3)
  pi.registerProvider("agentrouter", {
    baseUrl: "https://agentrouter.org/v1",
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
        input: ["text", "image"],
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
        input: ["text", "image"],
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
        },
      }
    ],
  });

  // 2. Anthropic Messages API models (claude-opus-4-8, claude-opus-5)
  pi.registerProvider("agentrouter-anthropic", {
    baseUrl: "https://agentrouter.org",
    api: "anthropic-messages",
    headers: {
      "User-Agent": "claude-cli/2.1.158 (external, sdk-cli)",
      "anthropic-version": "2023-06-01",
      "anthropic-beta": "claude-code-20250219,interleaved-thinking-2025-05-14,effort-2025-11-24,redact-thinking-2026-02-12",
      "anthropic-dangerous-direct-browser-access": "true",
      "x-app": "cli",
    },
    compat: {
      supportsDeveloperRole: false,
      cacheControlFormat: "anthropic",
      sendSessionAffinityHeaders: true,
    },
    models: [
      {
        id: "claude-opus-4-8",
        name: "Claude Opus 4.8 (AgentRouter)",
        reasoning: true,
        input: ["text", "image"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 8192,
        thinkingLevelMap: {
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
        },
        compat: {
          supportsDeveloperRole: false,
          cacheControlFormat: "anthropic",
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
        thinkingLevelMap: {
          low: "low",
          medium: "medium",
          high: "high",
          xhigh: "xhigh",
        },
        compat: {
          supportsDeveloperRole: false,
          cacheControlFormat: "anthropic",
        },
      }
    ],
  });

  // Mutate in place (return undefined). Cloning the payload drops provider fields.
  pi.on("before_provider_request", (event, ctx) => {
    if (!event.payload) return;
    const model = ctx.model as { provider?: string; baseUrl?: string } | undefined;
    if (!isAgentRouterCall(event.payload, model?.provider, model?.baseUrl)) return;
    sanitizeInPlace(event.payload);
    patchAgentRouterPayload(event.payload);
  });

  pi.on("message_end", (event, ctx) => {
    const message = event.message;
    if (message.role !== "assistant" || message.stopReason !== "error") return;
    const provider = message.provider ?? ctx.model?.provider;
    if (!provider?.toLowerCase().includes("agentrouter")) return;

    const errorMessage = message.errorMessage ?? "";
    if (errorMessage.includes("content-blocked")) {
      ctx.ui.notify(
        "AgentRouter content-blocked: WAF requires canonical Pi header at byte 0 of system prompt. Run /reload then /new.",
        "warning",
      );
    }
  });
}
