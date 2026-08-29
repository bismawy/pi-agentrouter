# pi-agentrouter

A [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension that registers [AgentRouter](https://agentrouter.org) as a unified custom provider (`agentrouter/`).

### Models (`agentrouter/`)

| Model | Context | Input | API Protocol |
|---|---|---|---|
| `agentrouter/gpt-5.6-sol` | 272k | text, image | OpenAI Completions (`/v1`) |
| `agentrouter/deepseek-v4-flash` | 131k | text | OpenAI Completions (`/v1`) |
| `agentrouter/glm-5.3` | 131k | text | OpenAI Completions (`/v1`) |
| `agentrouter/claude-opus-4-8` | 200k | text, image | Anthropic Messages |
| `agentrouter/claude-opus-5` | 200k | text, image | Anthropic Messages |

All models support reasoning with `low/medium/high/xhigh` thinking level mappings. Claude models automatically use per-model Anthropic Messages protocol overrides under the single `agentrouter/` provider namespace.

## Install

```bash
pi install npm:@bismawy/pi-agentrouter
```

Alternatively, straight from GitHub:

```bash
pi install git:github.com/bismawy/pi-agentrouter
```

## Setup

No API key is hardcoded into the extension — supply yours via:

1. Environment variable: `export AGENTROUTER_API_KEY="your-api-key"`
2. `/login agentrouter` in Pi
3. `models.json` under `providers.agentrouter.apiKey`

Then run `/model` and pick your desired model (`agentrouter/<model-id>`).

## Features & Fixes

- **Single Provider Namespace (`agentrouter/`)**: Seamlessly routes Claude models via per-model Anthropic Messages configuration while OpenAI, DeepSeek, and GLM models use OpenAI Completions.
- **Accurate Model Capabilities**: Declares `deepseek-v4-flash` and `glm-5.3` as `text`-only to prevent AgentRouter `type 参数非法` 400 errors when session history contains image artifacts.
- **Canonical Pi header (WAF)**: AgentRouter authorizes Pi traffic only when the system prompt starts with `You are an expert coding assistant operating inside pi...`. On the first turn, project `AGENTS.md` often lands *in front* of that line → `400 content-blocked`. This extension moves the header to byte 0 (same approach as [`@madgagarin/pi-agentrouter`](https://pi.dev/packages/@madgagarin/pi-agentrouter)).
- **Language framing**: Enforces explicit language processing instructions on user turns.
- **WAF Auto-Recovery (1.2.x)**: AgentRouter's content filter evaluates non-English token ratios across the request body. When blocked, the extension marks the error as retryable for Pi to restart the turn automatically while escalating history redaction exponentially (1 → 2 → 4 messages hidden per retry), keeping the latest user message intact. If a message is inherently self-blocking, a single deduplicated warning will guide you to rephrase or split it.
- **Payload sanitization**: Strips ANSI escapes, non-printable control characters, null bytes, and lone Unicode surrogates.
- **Session affinity**: `sendSessionAffinityHeaders: true` preserves prompt cache hits.

