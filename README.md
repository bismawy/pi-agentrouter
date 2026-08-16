# pi-extension-agentrouter

A [Pi coding agent](https://github.com/earendil-works/pi-coding-agent) extension that registers [AgentRouter](https://agentrouter.org) as a custom provider with two models:

| Model | Context | Input |
|---|---|---|
| `agentrouter/gpt-5.6-sol` | 272k | text, image |
| `agentrouter/claude-opus-5` | 200k | text, image |

Both are reasoning models; `gpt-5.6-sol` supports `low/medium/high/xhigh` thinking levels, `claude-opus-5` exposes `xhigh`.

## Install

```
pi install git:github.com/bismawy/pi-extension-agentrouter
```

(or `pi install npm:pi-extension-agentrouter` once published to npm)

## Setup

No API key is baked into the extension — supply yours via any of:

1. `/login agentrouter` (stored in Pi's auth store), or
2. a `providers.agentrouter.apiKey` entry in `%USERPROFILE%\.pi\agent\models.json`, or
3. the `AGENTROUTER_API_KEY` environment variable via an extension override.

Then `/model` → select `agentrouter/gpt-5.6-sol` or `agentrouter/claude-opus-5`.

## Details

- Endpoint: `https://agentrouter.org/v1` (`openai-completions` API).
- Sends the Codex CLI client headers (`Originator`, `User-Agent`, `Version`) expected by the channel.
- `sendSessionAffinityHeaders: true` keeps one Pi session on the same upstream for better cache hits.
- `supportsDeveloperRole: false` per model — developer-role messages are mapped to a form the endpoint accepts.

## Related

Pairs well with [pi-auto-compat](https://github.com/bismawy/pi-auto-compat), which auto-fills missing compat flags for any provider in `models.json`.
