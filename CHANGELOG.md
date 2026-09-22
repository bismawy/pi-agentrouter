# Changelog

All notable changes to this package. Releases older than 1.2.2 predate this file — see the git history and tags for details.

## 1.6.0 — 2026-09-22

### Changed — **breaking**

- The two account commands are now one command with subcommands, matching the `/jev-eye` pattern:
  - `/agentrouter-status` → `/agentrouter status`
  - `/agentrouter-usage` → `/agentrouter usage`
  Argument completion covers both subcommands.

### Added

- Interactive TUI menu for bare `/agentrouter` command (`pi-agentrouter · Menu`) with options for Status and Usage.
- Interactive TUI panels for `/agentrouter status` and `/agentrouter usage` matching the `/vision-watcher` design:
  - `DynamicBorder` framing in theme `accent`.
  - Contextual colors for model states (`ready` in green `success`, quota limits in `warning`, HTTP 5xx in `error`).
  - Dynamic table column sizing with auto-truncation for long backend errors.
  - Interactive legend footer (`[any key] close`) with fallback to plain-text formatting in non-TUI environments.
- Default `/agentrouter` menu notice in English with direct links to issues and referral registration.

## 1.5.0 — 2026-09-22

### Added

- **Stage 3 WAF recovery — translate the newest turn.** AgentRouter's filter scores the language mix of the whole request body. Redaction removes poisoned history, but when the newest turn is the trigger (first message of a session, or one long Indonesian message) there is nothing to hide and the turn used to be a dead end. That turn is now translated into English instead of being dropped: same meaning, English surface, which is what the filter gates on. Fenced code, inline layout, and the session's own text are never modified.
- **Translator backend on the user's own providers.** A cheap model is picked through `ctx.modelRegistry`, preferring flash/lite models on the user's own OAuth providers. AgentRouter itself can never be the translator — it blocks the Indonesian text it would be asked to translate. `AGENTROUTER_TRANSLATOR="provider/modelId"` pins the model, `AGENTROUTER_TRANSLATE=0` disables the stage.
- **Sticky, in-memory translation cache.** Translated turns stay English for the rest of the session; results are cached per turn (bounded, FIFO eviction, no disk writes) so a turn is never translated twice.
- **Reply language is preserved.** Translated turns are framed with a reply-in-Indonesian preamble variant, so answers still follow the user's language rather than the outgoing text.

### Changed

- Retry is only marked while a payload mutation is still possible: once a translation has been attempted and the turn is blocked again, the turn stops retrying with a single "please rephrase" notice instead of burning the retry budget on an identical payload.
- User-turn framing is idempotent across preamble variants (a sentinel check instead of an exact preamble prefix).

### Fixed

- The first message of a session no longer dies on `400 content-blocked` with no recovery path.

## 1.4.2 — 2026-09-12

### Added

- `/agentrouter-status`: live per-model quota probe against each model's own endpoint, using pricing cached for 24h.
- `/agentrouter-usage`: monthly billing total plus per-model token and cost breakdown aggregated from local pi sessions.

## 1.4.1 — 2026-09-12

### Fixed

- `supportsLongCacheRetention` and `forceAdaptiveThinking` are declared on the extension itself, so the provider no longer depends on `pi-auto-compat` injecting them.

## 1.4.0 — 2026-09-12

### Added

- GPT-6 Astra via the OpenAI Responses API (required for function tools with reasoning enabled).

### Fixed

- Declare session-affinity compat per model: pi only merges provider-level `compat` for `models.json` providers, so the provider-level block was dead code.

## 1.3.0 — 2026-09-07

### Fixed

- `400 content-blocked` from custom instructions preceding the canonical system-prompt header: the header is forced to byte 0 and all older user turns are redacted in one shot, keeping tool pairs and the newest turn intact.

## 1.2.2 — 2026-08-29

### Fixed

- WAF errors are marked retryable so pi restarts the turn automatically, escalating history redaction between attempts.

## Earlier releases

- Initial provider releases: Sol, Claude Opus, DeepSeek, and GLM routing under one `agentrouter/` namespace, payload sanitization (ANSI, control characters, orphan surrogates), and language framing on user turns.
