# AgentRouter

Unified frontier models. Self-healing WAF recovery. Zero workflow interruption.

[![Custom badge](https://shieldcn.dev/badge/pi-%20Packages.svg?variant=outline&size=xs&logo=ri%3APiPiBold)](https://pi.dev/packages/@bismawy/pi-agentrouter)
[![badge](https://shieldcn.dev/npm/@bismawy/pi-agentrouter.svg?variant=outline&size=xs)](https://www.npmjs.com/package/@bismawy/pi-agentrouter)
[![license](https://shieldcn.dev/github/bismawy/pi-agentrouter/license.svg?variant=outline&size=xs)](https://github.com/bismawy/pi-agentrouter)

<img src="https://raw.githubusercontent.com/bismawy/pi-agentrouter/main/assets/banner.webp" alt="AgentRouter: unified frontier models and self-healing WAF recovery for Pi" width="100%">

## Overview

pi-agentrouter provides a unified provider for [AgentRouter](https://agentrouter.org/register?aff=CKdn) in Pi — routing GPT-6 Astra, GPT-5.6 Sol, Claude Opus 4.8 / 5, DeepSeek V4 Flash, and GLM 5.3 under a single `agentrouter/` namespace with self-healing WAF recovery.

- **Protocol Routing:** GPT-6 Astra routes via OpenAI Responses, Claude models via Anthropic Messages, and others via OpenAI Completions under one provider.
- **WAF Header & Language Guard:** Forces Pi's canonical system header to byte 0 and applies language framing on user turns.
- **Self-Healing Recovery:** Redacts older history turns in two stages on content-filter triggers, and automatically translates the latest turn to English when needed.
- **Payload Sanitization:** Strips ANSI escape codes, null bytes, control characters, and orphan Unicode surrogates before dispatch.
- **Session Affinity:** Injects `sendSessionAffinityHeaders: true` by default to maximize server-side cache hits.

## Registered Models

| Model | Context | Input | Protocol | Thinking |
| :--- | :--- | :--- | :--- | :--- |
| `agentrouter/gpt-6-astra` | 272k | text, image | OpenAI Responses | `low` – `xhigh` |
| `agentrouter/gpt-5.6-sol` | 272k | text, image | OpenAI Completions | `low` – `xhigh` |
| `agentrouter/claude-opus-5` | 200k | text, image | Anthropic Messages | `low` – `xhigh` |
| `agentrouter/claude-opus-4-8` | 200k | text, image | Anthropic Messages | `low` – `xhigh` |
| `agentrouter/deepseek-v4-flash` | 131k | text | OpenAI Completions | `low` – `xhigh` |
| `agentrouter/glm-5.3` | 131k | text | OpenAI Completions | `low` – `xhigh` |

## Install

```bash
pi install npm:@bismawy/pi-agentrouter
```

Supply your API key via `/login agentrouter`, `export AGENTROUTER_API_KEY="your-key"`, or in `~/.pi/agent/models.json`.

> No account yet? [Register on AgentRouter](https://agentrouter.org/register?aff=CKdn) for a $50 bonus.

To test locally without installing:
```bash
pi -e ./index.ts
```

## Commands

| Command | Action |
| :--- | :--- |
| `/agentrouter` | Interactive menu with Status and Usage panels |
| `/agentrouter status` | View active models, status, and balance in a styled TUI panel |
| `/agentrouter usage` | Inspect session usage metrics and cost estimates |

## Architecture

<details>
<summary><b>WAF Auto-Recovery Lifecycle</b></summary>

1. Forces Pi's system prompt header to the very start of the payload.
2. On `content-blocked` or sensitive-words errors, marks the turn retryable for automatic recovery.
3. Stage 1 redacts older user turns; Stage 2 escalates to assistant turns while preserving tool pairs.
4. Stage 3 translates the newest turn to English if redaction is exhausted, avoiding user turn deletion.
5. Redaction depth resets on new conversations or compaction.

</details>

<details>
<summary><b>Development</b></summary>

```bash
npm test # Runs check-framing.ts self-checks
```

</details>

## License

Distributed under the **MIT** license.

## Author

[Bisma](https://github.com/bismawy)
