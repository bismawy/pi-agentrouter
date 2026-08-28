# pi-agentrouter

A [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension that registers [AgentRouter](https://agentrouter.org) as a custom provider with the following models:

| Model | Context | Input |
|---|---|---|
| `agentrouter/gpt-5.6-sol` | 272k | text, image |
| `agentrouter/claude-opus-5` | 200k | text, image |
| `agentrouter/deepseek-v4-flash` | 131k | text, image |
| `agentrouter/glm-5.3` | 131k | text, image |

All models are reasoning-capable with `low/medium/high/xhigh` thinking level mappings.

## Install

```
pi install npm:@bismawy/pi-agentrouter
```

Alternatively, straight from GitHub:

```
pi install git:github.com/bismawy/pi-agentrouter
```

## Setup

No API key is baked into the extension — supply yours via any of:

1. `/login agentrouter` (stored in Pi's auth store), or
2. a `providers.agentrouter.apiKey` entry in `%USERPROFILE%\.pi\agent\models.json` (or `~/.pi/agent/models.json` on Linux/macOS), or
3. the `AGENTROUTER_API_KEY` environment variable via an extension override.

Then `/model` → select `agentrouter/gpt-5.6-sol`, `agentrouter/claude-opus-5`, `agentrouter/deepseek-v4-flash`, or `agentrouter/glm-5.3`.

## Details

- Endpoint: `https://agentrouter.org/v1` (`openai-completions` API).
- Sends the Codex CLI client headers (`Originator`, `User-Agent`, `Version`) expected by the channel.
- `sendSessionAffinityHeaders: true` keeps one Pi session on the same upstream for better cache hits.
- `supportsDeveloperRole: false` per model — developer-role messages are mapped to a form the endpoint accepts.
- `deepseek-v4-flash` includes `requiresReasoningContentOnAssistantMessages: true` and `thinkingFormat: "deepseek"` for compatible reasoning block routing.

## Related

Pairs well with [pi-auto-compat](https://github.com/bismawy/pi-auto-compat), which auto-fills missing compat flags for any provider in `models.json`.
