/**
 * AgentRouter Provider Extension for pi
 *
 * Registers AgentRouter (https://agentrouter.org) as a custom provider
 * with GPT-5.6 Sol, Claude Opus 5, DeepSeek V4 Flash, and GLM 5.3 models.
 *
 * Setup:
 *   1. Set AGENTROUTER_API_KEY environment variable
 *   2. Install: pi install ./pi-extension-agentrouter
 *   3. /model → select agentrouter/gpt-5.6-sol, agentrouter/claude-opus-5,
 *      agentrouter/deepseek-v4-flash, or agentrouter/glm-5.3
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.registerProvider("agentrouter", {
    baseUrl: "https://agentrouter.org/v1",
    api: "openai-completions",
    // No apiKey here: users supply one via /login agentrouter, their own
    // models.json entry, or an apiKey field in an extension override.
    // Putting a key here would SHADOW one configured in models.json.
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
      },
    ],
  });
}