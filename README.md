# pi-agentrouter

A [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension that registers [AgentRouter](https://agentrouter.org) as a custom provider with both **OpenAI Completions** and **Anthropic Messages** API protocols:

### Models

#### OpenAI Compatible (`agentrouter/`) — `https://agentrouter.org/v1`
| Model | Context | Input |
|---|---|---|
| `agentrouter/gpt-5.6-sol` | 272k | text, image |
| `agentrouter/deepseek-v4-flash` | 131k | text, image |
| `agentrouter/glm-5.3` | 131k | text, image |

#### Anthropic Messages (`agentrouter-anthropic/`) — `https://agentrouter.org`
| Model | Context | Input |
|---|---|---|
| `agentrouter-anthropic/claude-opus-4-8` | 200k | text, image |
| `agentrouter-anthropic/claude-opus-5` | 200k | text, image |

All models are reasoning-capable with `low/medium/high/xhigh` thinking level mappings.

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
2. `/login agentrouter` (or `/login agentrouter-anthropic`) in Pi
3. `models.json` under `providers.agentrouter.apiKey`

Then run `/model` and pick your desired model.

## Features & Fixes

- **Separate Endpoints & Protocols**: Automatically splits Claude (Anthropic Messages protocol with Claude Code wire image) and OpenAI/GLM/DeepSeek (OpenAI Completions protocol).
- **Canonical Pi header (WAF)**: AgentRouter authorizes Pi traffic only when the system prompt starts with `You are an expert coding assistant operating inside pi...`. On the first turn, project `AGENTS.md` often lands *in front* of that line → `400 content-blocked`. This extension moves the header to byte 0 (same approach as [`@madgagarin/pi-agentrouter`](https://pi.dev/packages/@madgagarin/pi-agentrouter)).
- **Language framing** on the first user turn (non-English prompts).
- **Payload sanitization**: ANSI / control chars / lone surrogates.
- `sendSessionAffinityHeaders: true` preserves session affinity for prompt cache hits.

