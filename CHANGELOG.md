# Changelog

## [Unreleased]

### Changed
- `package.json` `description` now leads with the README tagline ("Unified frontier models. Self-healing WAF recovery. Zero workflow interruption.") followed by the capability summary, per the `/arnative-pi` manifest standard — pi.dev/packages renders this field verbatim as the package card description.

## [1.6.2] - 2026-09-30

### Fixed
- Fixed missing banner on pi.dev package page by syncing manifest `image` property to `assets/banner.webp`.

### Changed
- Added `"pi"` to package keywords in `package.json` for discoverability compliance.

---

## [1.6.1] - 2026-09-28

### Added
- Interactive TUI menu for bare `/agentrouter` command (`pi-agentrouter · Menu`) with selector options for Status and Usage.
- Added `dev` script (`pi -e ./index.ts`) in `package.json` for local live testing.

### Changed
- Refreshed README presentation layout, badge aesthetics, and structure to match the standard `arnative-pi` specification.
- Standardized README tagline (`Unified frontier models. Self-healing WAF recovery. Zero workflow interruption.`) and `package.json` description.
- Standardized full-width responsive banner image (`assets/banner.webp`).
- Registered `LICENSE` and `README.md` in `package.json` `"files"` packaging list.
- Updated AgentRouter public links in README and extension docs to canonical referral registration URL (`https://agentrouter.org/register?aff=CKdn`).

---

## [1.6.0] - 2026-09-22

### Changed
- The two account commands are now one command with subcommands matching the `/jev-eye` pattern: `/agentrouter status` and `/agentrouter usage`.

### Added
- Interactive TUI panels for `/agentrouter status` and `/agentrouter usage` matching the `/vision-watcher` design with `DynamicBorder` and contextual status colors.
- Default `/agentrouter` menu notice in English with direct links to issues and referral registration.

---

## [1.5.0] - 2026-09-22

### Added
- **Stage 3 WAF recovery — translate the newest turn.** When older history cannot unblock the WAF, the latest turn is automatically translated into English without deleting the request.
- **Translator backend on user's own providers.** A cheap model is picked through `ctx.modelRegistry`, preferring flash/lite models on user OAuth providers.
- **Sticky in-memory translation cache.** Translated turns stay English for the rest of the session.
- **Reply language preservation.** Translated turns are framed with a reply-in-Indonesian preamble variant.

### Changed
- Retry budget stops once a translation has been attempted and the turn is blocked again.
- User-turn framing is idempotent across preamble variants.

### Fixed
- The first message of a session no longer dies on `400 content-blocked` with no recovery path.

---

## [1.4.2] - 2026-09-12

### Added
- `/agentrouter status`: live per-model quota probe against each model endpoint using pricing cached for 24h.
- `/agentrouter usage`: monthly billing total plus per-model token and cost breakdown aggregated from local pi sessions.

---

## [1.4.1] - 2026-09-12

### Fixed
- `supportsLongCacheRetention` and `forceAdaptiveThinking` declared on the extension itself.

---

## [1.4.0] - 2026-09-12

### Added
- GPT-6 Astra via OpenAI Responses API.

### Fixed
- Declare session-affinity compat per model.

---

## [1.3.0] - 2026-09-07

### Fixed
- `400 content-blocked` from custom instructions preceding the canonical system-prompt header: the header is forced to byte 0 and all older user turns are redacted in one shot.

---

## [1.2.2] - 2026-08-29

### Fixed
- WAF errors are marked retryable so pi restarts the turn automatically, escalating history redaction between attempts.

---

## [1.0.1] - 2026-08-21

### Added
- Initial standalone release of `pi-agentrouter`: Sol, Claude Opus, DeepSeek, and GLM routing under one `agentrouter/` namespace, payload sanitization, and language framing.
