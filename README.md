<div align="center">

# pi-agentrouter

Unified [AgentRouter](https://agentrouter.org) provider for the [pi coding agent](https://github.com/earendil-works/pi-coding-agent) — routes GPT-5.6 Sol, Claude Opus 4.8 / 5, DeepSeek V4 Flash, and GLM 5.3 under a single `agentrouter/` namespace with WAF auto-recovery and payload sanitization.

[pi package](https://pi.dev/packages/@bismawy/pi-agentrouter) · [npm](https://www.npmjs.com/package/@bismawy/pi-agentrouter) · [Issues](https://github.com/bismawy/pi-agentrouter/issues)

![npm](https://img.shields.io/npm/v/@bismawy/pi-agentrouter)
![license](https://img.shields.io/badge/license-MIT-green)

</div>

<img src="assets/screenshot.webp" alt="pi-agentrouter" width="100%">

## What it does

- **Dual protocol routing:** Claude models go through Anthropic Messages, the rest through OpenAI Completions — all under one `agentrouter/` provider.
- **WAF header & language guard:** forces Pi's canonical system header to byte 0 (prevents `400 content-blocked` when custom instructions precede it) and applies language framing on user turns.
- **Self-healing WAF redaction:** when AgentRouter's content filter false-positives on multilingual histories, older turns are redacted in two stages and the turn is marked retryable — the latest request is preserved without user disruption.
- **Payload sanitization:** strips ANSI escape codes, null bytes, control characters, and orphan Unicode surrogates before dispatch.
- **Prompt cache affinity:** injects `sendSessionAffinityHeaders: true` by default to maximize server-side cache hits.

## Registered models

| Model | Context | Input | Protocol | Thinking |
| :--- | :--- | :--- | :--- | :--- |
| `agentrouter/gpt-5.6-sol` | 272k | text, image | OpenAI Completions | `low` – `xhigh` |
| `agentrouter/claude-opus-5` | 200k | text, image | Anthropic Messages | `low` – `xhigh` |
| `agentrouter/claude-opus-4-8` | 200k | text, image | Anthropic Messages | `low` – `xhigh` |
| `agentrouter/deepseek-v4-flash` | 131k | text | OpenAI Completions | `low` – `xhigh` |
| `agentrouter/glm-5.3` | 131k | text | OpenAI Completions | `low` – `xhigh` |

## Install

```bash
pi install npm:@bismawy/pi-agentrouter
```

Then supply your AgentRouter API key one of three ways:

- `/login agentrouter` in a Pi session
- `export AGENTROUTER_API_KEY="your-api-key"`
- `providers.agentrouter.apiKey` in `~/.pi/agent/models.json`

> No account yet? [Register via AgentRouter (referral)](https://agentrouter.org/register?aff=CKdn) for a $50 bonus.

Pick any model with `/model` (e.g. `agentrouter/gpt-5.6-sol`).

## How it works

<details>
<summary><b>WAF auto-recovery lifecycle</b></summary>

1. The extension forces Pi's system prompt header to the very start of the payload.
2. On a `content-blocked` / sensitive-words error, it marks the error retryable so Pi restarts the turn automatically.
3. Stage 1 redacts older user turns (`[Message withheld by local policy]`); Stage 2 escalates to assistant turns if needed, keeping tool pairs intact.
4. Redaction depth resets on new conversations or compaction.

</details>

<details>
<summary><b>Capability boundaries</b></summary>

Text-only models (`deepseek-v4-flash`, `glm-5.3`) are declared `input: ["text"]` so image payloads from earlier turns don't produce AgentRouter 400 errors.

</details>

## License

Distributed under the **MIT** license.

## Developer

Developed and maintained by [Bisma](https://github.com/bismawy).
