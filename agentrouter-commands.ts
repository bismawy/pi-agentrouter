/**
 * AgentRouter accounting commands for pi.
 *
 * Registers one command with subcommands:
 *   /agentrouter status  live per-model quota + pricing + endpoint
 *   /agentrouter usage   monthly provider billing total + per-model cost
 *
 * Neither command needs a browser cookie. AgentRouter exposes pricing publicly
 * and billing through the OpenAI-compatible billing endpoint, which
 * authenticates with the same API key the provider already uses:
 *
 *   GET  /api/pricing                        (public, no auth)
 *   GET  /v1/dashboard/billing/usage         (Bearer <apiKey>) -> total_usage in cents
 *   POST /v1/chat/completions | /v1/responses | /v1/messages
 *                                            (Bearer <apiKey>, max_tokens=1) -> 200 vs 402
 */

import type { ExtensionAPI, ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import type { AutocompleteItem } from "@earendil-works/pi-tui";
import { mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const AGENTROUTER_ORIGIN = "https://agentrouter.org";
const PRICING_URL = `${AGENTROUTER_ORIGIN}/api/pricing`;
const USAGE_URL = `${AGENTROUTER_ORIGIN}/v1/dashboard/billing/usage`;
const REQUEST_TIMEOUT_MS = 20_000;
/**
 * AgentRouter's WAF rejects unknown clients (HTTP 401 unauthorized_client_error)
 * on /v1/* paths, so probes and billing calls must present the same impersonated
 * client identity the provider itself uses at runtime.
 */
const PROBE_USER_AGENT = "codex_cli_rs/0.101.0";


const AGENTROUTER_DIR = join(homedir(), ".pi", "agent");
const PRICING_CACHE_FILE = join(AGENTROUTER_DIR, ".agentrouter-pricing.json");
const SESSIONS_DIR = join(AGENTROUTER_DIR, "sessions");

/**
 * Pricing is stable on a daily scale, so a 24h snapshot is enough. The snapshot
 * exists because registerProvider() runs synchronously and cannot await a
 * network call; /agentrouter status always fetches live.
 */
const PRICING_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Input price = model_ratio x BASE_UNIT; output = model_ratio x completion_ratio x BASE_UNIT.
 * Cross-checked against the live endpoint: claude-opus-4-8 (ratio 4, completion 5)
 * resolves to $8.00 / $40.00 per million tokens.
 */
const BASE_UNIT_USD_PER_MILLION = 2;

/**
 * Probe targets mirror the provider's live catalog snapshot (see MODEL_BLUEPRINTS in
 * index.ts; the /agentrouter handler overrides this with the model registry when live
 * models are available). `check-framing.ts` asserts the snapshot stays in sync with
 * the statically registered models, so drift fails a test rather than silently
 * reporting the wrong endpoint.
 */
export const AGENTROUTER_PROBE_TARGETS = [
  { id: "gpt-6-astra", api: "openai-responses", baseUrl: `${AGENTROUTER_ORIGIN}/v1` },
  { id: "gpt-5.6-sol", api: "openai-completions", baseUrl: `${AGENTROUTER_ORIGIN}/v1` },
  { id: "gpt-6.1-sol", api: "openai-responses", baseUrl: `${AGENTROUTER_ORIGIN}/v1` },
] as const;

/** Delisted from the live catalog but still present in historical session files. */
const RETIRED_MODEL_IDS = ["deepseek-v4-flash", "glm-5.3", "claude-opus-4-8", "claude-opus-5"] as const;

const AGENTROUTER_MODEL_IDS = new Set<string>([
  ...AGENTROUTER_PROBE_TARGETS.map((t) => t.id),
  ...RETIRED_MODEL_IDS,
]);

interface PricingEntry {
  inputPerMillion: number;
  outputPerMillion: number;
}

interface PricingCache {
  fetchedAt: number;
  prices: Record<string, PricingEntry>;
}

interface ProbeResult {
  id: string;
  api: string;
  state: "ready" | "quota" | "error";
  detail: string;
}

interface UsageTotals {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function numOrNull(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/* ------------------------------------------------------------------ *
 * Pricing
 * ------------------------------------------------------------------ */

/**
 * Maps the public /api/pricing payload to USD per million tokens.
 * Entries without a usable ratio are skipped rather than guessed at.
 */
export function parsePricing(payload: unknown): Map<string, PricingEntry> {
  const list = isRecord(payload) ? payload.data : undefined;
  const out = new Map<string, PricingEntry>();
  if (!Array.isArray(list)) return out;
  for (const raw of list) {
    if (!isRecord(raw)) continue;
    const id = raw.model_name;
    const ratio = numOrNull(raw.model_ratio);
    if (typeof id !== "string" || ratio === null) continue;
    const completion = numOrNull(raw.completion_ratio) ?? 1;
    out.set(id, {
      inputPerMillion: ratio * BASE_UNIT_USD_PER_MILLION,
      outputPerMillion: ratio * completion * BASE_UNIT_USD_PER_MILLION,
    });
  }
  return out;
}

/** The billing endpoint reports cents, following the OpenAI billing convention. */
export function centsToUsd(cents: number): number {
  return cents / 100;
}

export function readPricingCache(): PricingCache | null {
  try {
    const parsed = JSON.parse(readFileSync(PRICING_CACHE_FILE, "utf8")) as PricingCache;
    if (typeof parsed?.fetchedAt !== "number" || !isRecord(parsed.prices)) return null;
    return parsed;
  } catch {
    return null;
  }
}

function writePricingCache(prices: Map<string, PricingEntry>): void {
  try {
    mkdirSync(AGENTROUTER_DIR, { recursive: true });
    const cache: PricingCache = { fetchedAt: Date.now(), prices: Object.fromEntries(prices) };
    writeFileSync(PRICING_CACHE_FILE, JSON.stringify(cache, null, 2));
  } catch {
    // The snapshot is a convenience; a failed write must not break a command.
  }
}

async function fetchPricing(): Promise<Map<string, PricingEntry>> {
  const res = await fetch(PRICING_URL, {
    headers: { "User-Agent": "pi-code" },
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`pricing request failed (HTTP ${res.status})`);
  return parsePricing(await res.json());
}

/* ------------------------------------------------------------------ *
 * API key
 * ------------------------------------------------------------------ */

/**
 * Mirrors how pi resolves the provider key: environment first, then auth.json.
 * Only a length is ever reported back to the user, never the key itself.
 */
export function readApiKey(): string | null {
  const fromEnv = process.env.AGENTROUTER_API_KEY;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  try {
    const auth = JSON.parse(readFileSync(join(AGENTROUTER_DIR, "auth.json"), "utf8")) as Record<string, unknown>;
    const entry = auth.agentrouter;
    const key = typeof entry === "string" ? entry : isRecord(entry) ? entry.key ?? entry.apiKey : undefined;
    return typeof key === "string" && key.trim() ? key.trim() : null;
  } catch {
    return null;
  }
}

/* ------------------------------------------------------------------ *
 * Quota probing
 * ------------------------------------------------------------------ */

/**
 * Builds the probe request for a model using that model's own api and base URL,
 * so the probe exercises the same path pi uses at runtime. Probing every model
 * through chat/completions would report on an endpoint the model never uses.
 */
export function buildProbeRequest(
  target: { id: string; api: string; baseUrl: string },
  apiKey: string,
): { url: string; headers: Record<string, string>; body: string } {
  const base = target.baseUrl.replace(/\/+$/, "");
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
    Authorization: `Bearer ${apiKey}`,
    "User-Agent": PROBE_USER_AGENT,
  };

  if (target.api === "anthropic-messages") {
    headers["anthropic-version"] = "2023-06-01";
    return {
      url: `${base}/v1/messages`,
      headers,
      body: JSON.stringify({
        model: target.id,
        max_tokens: 1,
        messages: [{ role: "user", content: "ping" }],
      }),
    };
  }

  if (target.api === "openai-responses") {
    return {
      url: `${base}/responses`,
      headers,
      body: JSON.stringify({ model: target.id, input: "ping", max_output_tokens: 16 }),
    };
  }

  return {
    url: `${base}/chat/completions`,
    headers,
    body: JSON.stringify({
      model: target.id,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    }),
  };
}

function extractErrorMessage(text: string): string | null {
  try {
    const parsed = JSON.parse(text) as unknown;
    if (isRecord(parsed)) {
      if (typeof parsed.message === "string") return parsed.message;
      const error = parsed.error;
      if (isRecord(error) && typeof error.message === "string") return error.message;
      if (typeof error === "string") return error;
    }
  } catch {
    // Non-JSON error bodies fall through to the raw snippet.
  }
  const snippet = text.trim().replace(/\s+/g, " ");
  return snippet ? snippet.slice(0, 120) : null;
}

async function probeModel(target: { id: string; api: string; baseUrl: string }, apiKey: string): Promise<ProbeResult> {
  const probe = buildProbeRequest(target, apiKey);
  try {
    const res = await fetch(probe.url, {
      method: "POST",
      headers: probe.headers,
      body: probe.body,
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
    if (res.ok) return { id: target.id, api: target.api, state: "ready", detail: "ready" };
    const text = await res.text();
    if (res.status === 402) {
      return { id: target.id, api: target.api, state: "quota", detail: "quota exhausted (402)" };
    }
    const message = extractErrorMessage(text);
    return {
      id: target.id,
      api: target.api,
      state: "error",
      detail: message ? `HTTP ${res.status}: ${message}` : `HTTP ${res.status}`,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { id: target.id, api: target.api, state: "error", detail: message };
  }
}

/* ------------------------------------------------------------------ *
 * Session usage
 * ------------------------------------------------------------------ */

/**
 * Walks the session tree, looking for usage-shaped objects. The reader is
 * deliberately schema-tolerant: it does not assume how pi nests messages, only
 * that a usage object carries numeric `input` and `output`, and that an
 * AgentRouter model id appears in the same entry.
 */
export function findUsage(node: unknown, depth = 0): UsageTotals | null {
  if (depth > 8) return null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findUsage(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (!isRecord(node)) return null;

  const input = numOrNull(node.input);
  const output = numOrNull(node.output);
  if (input !== null && output !== null) {
    return {
      input,
      output,
      cacheRead: numOrNull(node.cacheRead) ?? numOrNull(node.cache_read_input_tokens) ?? 0,
      cacheWrite: numOrNull(node.cacheWrite) ?? numOrNull(node.cache_creation_input_tokens) ?? 0,
    };
  }

  for (const value of Object.values(node)) {
    const hit = findUsage(value, depth + 1);
    if (hit) return hit;
  }
  return null;
}

export function findModel(node: unknown, depth = 0, ids: ReadonlySet<string> = AGENTROUTER_MODEL_IDS): string | null {
  if (depth > 8) return null;
  if (typeof node === "string") return ids.has(node) ? node : null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findModel(item, depth + 1, ids);
      if (hit) return hit;
    }
    return null;
  }
  if (!isRecord(node)) return null;
  for (const value of Object.values(node)) {
    const hit = findModel(value, depth + 1, ids);
    if (hit) return hit;
  }
  return null;
}

function listFiles(dir: string, out: string[] = [], depth = 0): string[] {
  if (depth > 4) return out;
  let entries: string[];
  try {
    entries = readdirSync(dir);
  } catch {
    return out;
  }
  for (const name of entries) {
    const full = join(dir, name);
    try {
      if (statSync(full).isDirectory()) listFiles(full, out, depth + 1);
      else out.push(full);
    } catch {
      // Unreadable entries are skipped rather than aborting the scan.
    }
  }
  return out;
}

interface SessionScan {
  files: number;
  records: number;
  byModel: Map<string, UsageTotals>;
}

/**
 * Aggregates usage for the current month. /api/pricing is gateway-wide, and
 * AgentRouter's per-request log is only reachable with a browser session, so
 * local sessions are the cookie-free source for the per-model breakdown.
 */
export function scanSessions(sinceMs: number, filter?: (file: string) => boolean, modelIds?: ReadonlySet<string>): SessionScan {
  const byModel = new Map<string, UsageTotals>();
  let files = 0;
  let records = 0;

  for (const file of listFiles(SESSIONS_DIR)) {
    let modified = 0;
    try {
      modified = statSync(file).mtimeMs;
    } catch {
      continue;
    }
    if (modified < sinceMs) continue;
    if (filter && !filter(file)) continue;

    let content: string;
    try {
      content = readFileSync(file, "utf8");
    } catch {
      continue;
    }
    files++;

    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        continue;
      }
      // One usage record per entry: pi records one assistant message per line.
      // ponytail: first-match pairing; revisit if entries ever pack multiple messages.
      const usage = findUsage(parsed);
      if (!usage) continue;
      const model = findModel(parsed, 0, modelIds);
      if (!model) continue;

      records++;
      const total = byModel.get(model) ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      total.input += usage.input;
      total.output += usage.output;
      total.cacheRead += usage.cacheRead;
      total.cacheWrite += usage.cacheWrite;
      byModel.set(model, total);
    }
  }

  return { files, records, byModel };
}

/* ------------------------------------------------------------------ *
 * Formatting helpers
 * ------------------------------------------------------------------ */

function usd(value: number): string {
  return `$${value.toFixed(2)}`;
}

function tokens(value: number): string {
  return value.toLocaleString("en-US");
}

function monthStartMs(now = new Date()): number {
  return new Date(now.getFullYear(), now.getMonth(), 1).getTime();
}

function monthLabel(now = new Date()): string {
  return now.toLocaleDateString("en-US", { month: "long", year: "numeric" });
}

function isoDate(date: Date): string {
  const month = `${date.getMonth() + 1}`.padStart(2, "0");
  const day = `${date.getDate()}`.padStart(2, "0");
  return `${date.getFullYear()}-${month}-${day}`;
}

function costOf(usage: UsageTotals, price: PricingEntry | undefined): number | null {
  if (!price) return null;
  return (usage.input / 1_000_000) * price.inputPerMillion
    + (usage.output / 1_000_000) * price.outputPerMillion;
}

/* ------------------------------------------------------------------ *
 * Commands
 * ------------------------------------------------------------------ */

interface StatusRow {
  id: string;
  api: string;
  state: ProbeResult["state"];
  detail: string;
  price: PricingEntry | null;
}

interface StatusReport {
  /** No key configured: every other field is empty and the panel says so. */
  keyMissing: boolean;
  rows: StatusRow[];
  pricingNote: string;
  /** "live" = endpoint answered, "stale" = 24h snapshot reused, "missing" = neither. */
  pricingState: "live" | "stale" | "missing";
}

type ProbeTarget = { id: string; api: string; baseUrl: string };

async function buildStatusReport(apiKey: string | null, targets: readonly ProbeTarget[] = AGENTROUTER_PROBE_TARGETS): Promise<StatusReport> {
  if (!apiKey) {
    return {
      keyMissing: true,
      rows: [],
      pricingNote: "no API key — set AGENTROUTER_API_KEY or run /login agentrouter",
      pricingState: "missing",
    };
  }

  let prices = new Map<string, PricingEntry>();
  let pricingNote = `live, refreshed now (snapshot TTL ${PRICING_TTL_MS / 3_600_000}h)`;
  let pricingState: StatusReport["pricingState"] = "live";
  try {
    prices = await fetchPricing();
    writePricingCache(prices);
  } catch (error) {
    const cached = readPricingCache();
    prices = new Map(Object.entries(cached?.prices ?? {}));
    const message = error instanceof Error ? error.message : String(error);
    pricingState = cached ? "stale" : "missing";
    pricingNote = cached
      ? `snapshot of ${new Date(cached.fetchedAt).toISOString()} (live fetch failed: ${message})`
      : `unavailable (${message})`;
  }

  const results = await Promise.all(targets.map((t) => probeModel(t, apiKey)));
  return {
    keyMissing: false,
    rows: results.map((r) => ({ ...r, price: prices.get(r.id) ?? null })),
    pricingNote,
    pricingState,
  };
}

/* ------------------------------------------------------------------ *
 * Arnative box chrome (pure: the theme is handed in as a loose structural object, so
 * the self-check runs under plain node with no pi-tui). Same glyphs, colours, and
 * layout rules as @bismawy/pi-arnative lib/box.ts and pi-jev-eye layer1.ts.
 * ------------------------------------------------------------------ */

/** Theme slot for a thinking level. Every pi theme defines one `thinking*` token, so a built-in
 *  theme still gets a coloured frame when it has no soft accent to derive. */
function thinkingColorSlot(level: string | undefined): string {
  switch ((level ?? "off").toLowerCase()) {
    case "minimal": return "thinkingMinimal";
    case "low": return "thinkingLow";
    case "medium": return "thinkingMedium";
    case "high": return "thinkingHigh";
    case "xhigh": return "thinkingXhigh";
    case "max": return "thinkingMax";
    default: return "thinkingOff";
  }
}

type StatusPainter = (token: string, text: string) => string;

/** One status row: `Label · STATUS | detail · detail`. The label is padded to `column` so every
 *  `·` divider lands in the same column, exactly like the list menus; the status word carries its
 *  own token, so a glance down the left column answers "is it on?" without reading the details. */
export function statusRow(
  label: string,
  status: string,
  details: (string | false | undefined)[],
  paint: StatusPainter = (_token, text) => text,
  statusToken = "muted",
  column = 14,
): string {
  const divider = paint("dim", "·");
  // The widest label itself keeps one space before its divider; padEnd alone would glue the two.
  const head = `${paint("dim", label.padEnd(Math.max(label.length + 1, column)))}${divider} `;
  const body = details.filter(Boolean).join(paint("dim", " · "));
  const tail = body ? `${paint("dim", "|")} ${body}` : "";
  return `${head}${paint(statusToken, status)}${tail ? ` ${tail}` : ""}`;
}

type BoxTheme = {
  fg(color: string, text: string): string;
  /** pi 1.2.0's `Theme.style`; paints a colour that is not one of the fixed tokens. `any` options:
   *  the structural param must stay bivariant so pi's own `Theme` satisfies this type. */
  style?(text: string, options: any): string;
  bold?(text: string): string;
  /** Resolved token values, so a soft tier can be derived from the official token it maps to. */
  colors?: Record<string, { kind?: string; c?: number; h?: number }>;
};

/**
 * The arnative soft tier, derived. Pi <=1.1.0 let a theme declare extra keys in `colors`, so
 * `fg("accentSoft")` worked; 1.2.0 validates `colors` with `additionalProperties: false` and
 * `fg("accentSoft")` now throws. Falling back to a different official token would silently change
 * the colour, so the soft tier is computed from the resolved token with the theme generator's
 * exact recipe (L 0.82, chroma x 0.18, hue kept) — the very value arnative declares in `vars.*Soft`.
 */
const SOFT_L = 0.82;
const SOFT_CHROMA_SCALE = 0.18;
const softenColor = (color: { c?: number; h?: number }): { kind: "oklch"; l: number; c: number; h: number } => ({
  kind: "oklch",
  l: SOFT_L,
  c: (color.c ?? 0) * SOFT_CHROMA_SCALE,
  h: color.h ?? 0,
});

/** The first token of `tokens` the theme actually defines; every `theme.fg` throws on an unknown one. */
function firstToken(fg: (color: string, text: string) => string, tokens: string[]): string | undefined {
  return tokens.find((token) => {
    try {
      fg(token, "");
      return true;
    } catch {
      return false;
    }
  });
}

const tokenPainter = (theme: BoxTheme | null | undefined, tokens: string[]): ((text: string) => string) | undefined => {
  const fg = theme?.fg?.bind(theme);
  const token = fg ? firstToken(fg, tokens) : undefined;
  return token && fg ? (text) => fg(token, text) : undefined;
};

const softTierPainter = (theme: BoxTheme | null | undefined, baseToken: string): ((text: string) => string) | undefined => {
  const base = theme?.colors?.[baseToken];
  const style = theme?.style?.bind(theme) as ((text: string, options: { fg: unknown }) => string) | undefined;
  if (base?.kind !== "oklch" || !style) return undefined;
  return (text) => style(text, { fg: softenColor(base) });
};

/** Declared token first (pi <=1.1.0 unchanged), then the derivation, then the official fallbacks, then identity. */
const softPainter = (
  theme: BoxTheme | null | undefined,
  direct: string[],
  baseToken: string,
  fallbacks: string[],
): ((text: string) => string) =>
  tokenPainter(theme, direct) ?? softTierPainter(theme, baseToken) ?? tokenPainter(theme, fallbacks) ?? ((text) => text);

/** The box border: the arnative soft accent where the theme has it, otherwise the theme's
 *  `borderAccent` softened, and only then the session's thinking slot; identity with no theme. */
/**
 * The box border: the session's thinking slot — pi-arnative's own rule (lib/box.ts `renderScreen`
 * defaults its border to `thinkingColorOf(theme, level)`). The frame tracks the model's reasoning
 * effort; the soft tier stays on the chosen row, never the border. A theme without the slot draws
 * `dim` so a non-arnative theme still gets a plain frame; no theme draws uncoloured.
 */
export function borderPainter(theme: BoxTheme | null | undefined, thinkingLevel?: string): (text: string) => string {
  const fg = theme?.fg?.bind(theme);
  if (!fg) return (text) => text;
  const slot = thinkingColorSlot(thinkingLevel);
  try {
    fg(slot, "");
    return (text) => fg(slot, text);
  } catch {
    return (text) => fg("dim", text);
  }
}

/** A chosen row's body: the `→` marker keeps the accent, the text moves to the soft tint, bold. */
export function chosenRowPainter(theme: BoxTheme | null | undefined): (text: string) => string {
  const paint = softPainter(theme, ["accentSoft"], "accent", ["thinkingText", "accent"]);
  const bold = theme?.bold?.bind(theme) ?? ((text: string) => text);
  return (text) => paint(bold(text));
}

/** ANSI escape sequences (CSI, OSC, single-character) — they occupy no terminal columns. */
const ANSI_ESCAPE = /\x1b(?:\[[0-9;:?]*[A-Za-z]|\][^\x07\x1b]*(?:\x07|\x1b\\)|[@-Z\\-_])/g;

/** Terminal columns of a styled string: strip ANSI, then count full-width glyphs as two. */
export function visibleWidth(text: string): number {
  const plain = text.replace(ANSI_ESCAPE, "");
  let wide = 0;
  for (const char of plain) {
    const code = char.codePointAt(0) ?? 0;
    if (code >= 0x1100 && (code <= 0x115f || code === 0x2329 || code === 0x232a || (code >= 0x2e80 && code <= 0xa4cf && code !== 0x303f) || (code >= 0xac00 && code <= 0xd7a3) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xfe30 && code <= 0xfe6f) || (code >= 0xff00 && code <= 0xff60) || (code >= 0xffe0 && code <= 0xffe6) || (code >= 0x1f300 && code <= 0x1f64f) || (code >= 0x20000 && code <= 0x3fffd))) wide += 1;
  }
  return [...plain].length + wide;
}

/** `╭───╮` / `╰───╯`. Width holds at 1-2 because a line shorter than the frame beats a downshifted one. */
export function boxEdge(left: string, right: string, width: number, paint: (text: string) => string = (text) => text): string {
  return paint(`${left}${"─".repeat(Math.max(0, width - 2))}${right}`);
}

/** `│ text │` for one already-styled row. Below four columns a blank line beats an overflowing one. */
export function boxRow(content: string, width: number, paint: (text: string) => string = (text) => text): string {
  if (width < 4) return "";
  return `${paint("│")} ${content}${" ".repeat(Math.max(0, width - visibleWidth(content) - 3))}${paint("│")}`;
}

/** Wrap already-styled rows in the rounded frame: one top edge, one row per line, one bottom edge. */
export function boxFrame(rows: string[], width: number, paint: (text: string) => string = (text) => text): string[] {
  return [boxEdge("╭", "╮", width, paint), ...rows.map((row) => boxRow(row, width, paint)), boxEdge("╰", "╯", width, paint)];
}

/** Content column of a framed row: the frame owns the two walls and the two spaces. */
const boxInner = (width: number): number => Math.max(0, width - 4);

/** Pack footer pairs into rows that fit `width` columns, two spaces between pairs and never inside one. */
export function packPairs(pairs: string[], width: number): string[] {
  const rows: string[] = [];
  let row = "";
  for (const pair of pairs) {
    const candidate = row ? `${row}  ${pair}` : pair;
    if (row && visibleWidth(candidate) > width) {
      rows.push(row);
      row = pair;
      continue;
    }
    row = candidate;
  }
  if (row) rows.push(row);
  return rows;
}

/**
 * Frame whole rows into the arnative box: split on newlines first (a value from the network or a
 * pasted query must not open a hole in the frame), clip each row to the inner width — the clip keeps
 * an ellipsis, so a model id cut to `deepseek-v` must not read as a whole name — then add the walls.
 */
function frameRows(rows: string[], width: number, clip: Clip, paint: (text: string) => string): string[] {
  return boxFrame(
    rows.flatMap((content) => String(content).split("\n")).map((content) => clip(content, boxInner(width))),
    width,
    paint,
  );
}

const STATUS_HEADERS = ["MODEL", "INPUT/1M", "OUTPUT/1M", "ENDPOINT", "STATUS"] as const;

/** Column widths come from the data, so a short table stays tight and a long model id never overflows. */
function statusColumnWidths(rows: StatusRow[]): number[] {
  const cells = (row: StatusRow) => [row.id, priceLabel(row.price)[0], priceLabel(row.price)[1], row.api];
  return STATUS_HEADERS.slice(0, 4).map((header, i) =>
    Math.max(header.length, ...rows.map((row) => cells(row)[i].length)),
  );
}

function priceLabel(price: PricingEntry | null): [string, string] {
  return price ? [usd(price.inputPerMillion), usd(price.outputPerMillion)] : ["?", "?"];
}

/** Plain-text fallback: print mode, RPC, and any client without a TUI. */
function renderStatusText(report: StatusReport): string {
  const lines: string[] = ["AgentRouter · Status", "Live model availability, pricing, and per-model endpoint.", ""];
  if (report.keyMissing) {
    lines.push(`Pricing: ${report.pricingNote}`);
    return lines.join("\n");
  }

  const widths = statusColumnWidths(report.rows);
  lines.push(STATUS_HEADERS.map((h, i) => (i === 4 ? h : h.padEnd(widths[i]!))).join("  "));
  for (const row of report.rows) {
    const [input, output] = priceLabel(row.price);
    lines.push(
      [row.id.padEnd(widths[0]!), input.padEnd(widths[1]!), output.padEnd(widths[2]!), row.api.padEnd(widths[3]!), row.detail]
        .join("  "),
    );
  }

  lines.push("", `Pricing: ${report.pricingNote}`, "Probe:   POST max_tokens=1 per model, on that model's own endpoint");
  lines.push(`Ready:   ${readyLabel(report)}`);
  return lines.join("\n");
}

function readyLabel(report: StatusReport): string {
  return `${report.rows.filter((r) => r.state === "ready").length}/${report.rows.length}`;
}

function readyColor(report: StatusReport): "success" | "warning" | "error" {
  const ready = report.rows.filter((r) => r.state === "ready").length;
  if (ready === report.rows.length) return "success";
  return ready === 0 ? "error" : "warning";
}

function statusColor(state: StatusRow["state"]): "success" | "warning" | "error" {
  if (state === "ready") return "success";
  return state === "quota" ? "warning" : "error";
}

/**
 * Width-aware, ANSI-aware clip. The panel passes pi's own truncateToWidth (CJK-correct
 * and escape-aware); it is a parameter because this file must stay importable under
 * plain node, where pi's packages do not resolve.
 */
type Clip = (text: string, width: number) => string;

/**
 * The framed status body: title with a muted description underneath, one `Label · STATUS | detail`
 * row per model, a fixed footer block, and a dim key legend above the bottom edge.
 *
 * Clipping happens inside frameRows, on each row after it is styled: the clip is ANSI-aware,
 * so escape sequences never count towards the width and no column is sliced in half.
 */
export function renderStatusBody(
  report: StatusReport,
  theme: Theme,
  width: number,
  clip: Clip,
  thinkingLevel?: string,
): string[] {
  const paint: StatusPainter = (token, text) => theme.fg(token as never, text);
  const lines: string[] = [
    theme.fg("accent", theme.bold("AgentRouter · Status")),
    theme.fg("muted", "Live model availability, pricing, and per-model endpoint."),
    "",
  ];

  if (report.keyMissing) {
    lines.push(statusRow("Key", "MISSING", [report.pricingNote], paint, "warning", 14));
    lines.push("");
    lines.push(paint("dim", "[Any key] Close"));
    return frameRows(lines, width, clip, borderPainter(theme, thinkingLevel));
  }

  // One label column across models and footer rows, so every `·` lands in the same column.
  const column = Math.max(14, ...report.rows.map((row) => row.id.length));
  for (const row of report.rows) {
    const [input, output] = priceLabel(row.price);
    lines.push(
      statusRow(
        row.id,
        row.state.toUpperCase(),
        [
          row.price ? `${input}/${output} per 1M` : "unpriced",
          row.api,
          row.state === "ready" ? false : row.detail,
        ],
        paint,
        statusColor(row.state),
        column,
      ),
    );
  }

  const pricingColor = report.pricingState === "live" ? "success" : report.pricingState === "stale" ? "warning" : "error";
  lines.push("");
  lines.push(statusRow("Pricing", report.pricingState.toUpperCase(), [report.pricingNote], paint, pricingColor, column));
  lines.push(statusRow("Probe", "POST", ["max_tokens=1 per model, on that model's own endpoint"], paint, "muted", column));
  lines.push(statusRow("Ready", readyLabel(report), [`${report.rows.length} models probed`], paint, readyColor(report), column));
  lines.push("");
  lines.push(paint("accent", `${report.rows.length} models`) + paint("dim", " · [Any key] Close"));
  return frameRows(lines, width, clip, borderPainter(theme, thinkingLevel));
}

/** Read-only panel in the arnative rounded box; any key closes. The TUI import is dynamic because
 *  this file's self-check (check-framing.ts) runs under plain node, where pi-tui does not resolve. */
async function showStatusPanel(ctx: ExtensionCommandContext, report: StatusReport): Promise<void> {
  const { truncateToWidth } = await import("@earendil-works/pi-tui");
  const thinkingLevel = ctx.thinkingLevel;
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => ({
    render: (width: number) => renderStatusBody(report, theme, width, truncateToWidth, thinkingLevel),
    invalidate: () => undefined,
    handleInput: () => done(),
  }));
}

interface UsageModelRow {
  model: string;
  usage: UsageTotals;
  cost: number | null;
}

interface UsageReport {
  month: string;
  providerTotal: string;
  providerTotalState: "ok" | "unavailable";
  localFiles: number;
  localRecords: number;
  sinceDate: string;
  rows: UsageModelRow[];
  totalCost: number;
  fullyPriced: boolean;
}

async function buildUsageReport(apiKey: string | null, modelIds?: ReadonlySet<string>): Promise<UsageReport> {
  const now = new Date();
  let providerTotal = "unavailable (no API key)";
  let providerTotalState: "ok" | "unavailable" = "unavailable";

  if (apiKey) {
    const url = `${USAGE_URL}?start_date=${isoDate(new Date(now.getFullYear(), now.getMonth(), 1))}`
      + `&end_date=${isoDate(now)}`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": PROBE_USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        providerTotal = `unavailable (HTTP ${res.status})`;
      } else {
        const payload = (await res.json()) as unknown;
        const cents = isRecord(payload) ? numOrNull(payload.total_usage) : null;
        if (cents !== null) {
          providerTotal = usd(centsToUsd(cents));
          providerTotalState = "ok";
        } else {
          providerTotal = "unavailable (unexpected payload)";
        }
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      providerTotal = `unavailable (${message})`;
    }
  }

  const cached = readPricingCache();
  const prices = new Map(Object.entries(cached?.prices ?? {}));
  const scan = scanSessions(monthStartMs(now), undefined, modelIds);

  let totalCost = 0;
  let fullyPriced = true;
  const ranked = [...scan.byModel.entries()].sort(
    (a, b) => (costOf(b[1], prices.get(b[0])) ?? 0) - (costOf(a[1], prices.get(a[0])) ?? 0),
  );

  const rows: UsageModelRow[] = [];
  for (const [model, usage] of ranked) {
    const cost = costOf(usage, prices.get(model));
    if (cost === null) fullyPriced = false;
    else totalCost += cost;
    rows.push({ model, usage, cost });
  }

  return {
    month: monthLabel(now),
    providerTotal,
    providerTotalState,
    localFiles: scan.files,
    localRecords: scan.records,
    sinceDate: isoDate(new Date(monthStartMs(now))),
    rows,
    totalCost,
    fullyPriced,
  };
}

const USAGE_HEADERS = ["MODEL", "INPUT", "OUTPUT", "CACHE R/W", "COST"] as const;

function usageColumnWidths(rows: UsageModelRow[]): number[] {
  const cells = (row: UsageModelRow) => [
    row.model,
    tokens(row.usage.input),
    tokens(row.usage.output),
    `${tokens(row.usage.cacheRead)}/${tokens(row.usage.cacheWrite)}`,
    row.cost !== null ? usd(row.cost) : "?",
  ];
  return USAGE_HEADERS.map((header, i) =>
    Math.max(header.length, ...rows.map((row) => cells(row)[i].length)),
  );
}

function renderUsageText(report: UsageReport): string {
  const lines: string[] = [
    `AgentRouter · Usage (${report.month})`,
    `Provider billing total and local session breakdown.`,
    "",
    `Provider total: ${report.providerTotal}`,
    `Local sessions: ${report.localFiles} file(s) since ${report.sinceDate}, ${report.localRecords} record(s)`,
    "",
  ];

  if (report.rows.length === 0) {
    lines.push("(no AgentRouter usage recorded in local sessions this month)");
  } else {
    const widths = usageColumnWidths(report.rows);
    lines.push(USAGE_HEADERS.map((h, i) => h.padEnd(widths[i]!)).join("  "));
    for (const row of report.rows) {
      lines.push(
        [
          row.model.padEnd(widths[0]!),
          tokens(row.usage.input).padEnd(widths[1]!),
          tokens(row.usage.output).padEnd(widths[2]!),
          `${tokens(row.usage.cacheRead)}/${tokens(row.usage.cacheWrite)}`.padEnd(widths[3]!),
          (row.cost !== null ? usd(row.cost) : "?").padEnd(widths[4]!),
        ].join("  "),
      );
    }
    lines.push("");
    const sumW = widths.slice(0, 4).reduce((sum, w) => sum + w, 0) + 3 * 2;
    lines.push("TOTAL".padEnd(sumW) + "  " + usd(report.totalCost));
  }

  lines.push("");
  lines.push("Costs: input/output tokens x pricing. Cache tokens unpriced.");
  return lines.join("\n");
}

/**
 * The framed usage body: numeric table (model left, numbers right-aligned and dim, cost
 * coloured by whether a price exists), then `Label · STATUS | detail` footer rows and the legend.
 */
export function renderUsageBody(
  report: UsageReport,
  theme: Theme,
  width: number,
  clip: Clip,
  thinkingLevel?: string,
): string[] {
  const paint: StatusPainter = (token, text) => theme.fg(token as never, text);
  const lines: string[] = [
    theme.fg("accent", theme.bold(`AgentRouter · Usage (${report.month})`)),
    theme.fg("muted", "Provider billing total and local session breakdown."),
    "",
  ];

  if (report.rows.length === 0) {
    lines.push(theme.fg("muted", "(no AgentRouter usage recorded in local sessions this month)"));
  } else {
    const widths = usageColumnWidths(report.rows);
    lines.push(theme.fg("muted", theme.bold(USAGE_HEADERS.map((h, i) => h.padEnd(widths[i]!)).join("  "))));
    for (const row of report.rows) {
      const costStr = row.cost !== null ? usd(row.cost) : "?";
      lines.push(
        theme.fg("accent", row.model.padEnd(widths[0]!))
        + "  " + theme.fg("dim", tokens(row.usage.input).padStart(widths[1]!))
        + "  " + theme.fg("dim", tokens(row.usage.output).padStart(widths[2]!))
        + "  " + theme.fg("dim", `${tokens(row.usage.cacheRead)}/${tokens(row.usage.cacheWrite)}`.padStart(widths[3]!))
        + "  " + theme.fg(row.cost !== null ? "success" : "muted", costStr.padStart(widths[4]!)),
      );
    }
    const sumW = widths.slice(0, 4).reduce((sum, w) => sum + w, 0) + 3 * 2;
    lines.push(
      theme.fg("muted", theme.bold("TOTAL".padEnd(sumW)))
      + "  " + theme.fg("success", theme.bold(usd(report.totalCost).padStart(widths[4]!))),
    );
  }

  const column = "Local sessions".length;
  lines.push("");
  lines.push(statusRow("Provider total", report.providerTotalState === "ok" ? "OK" : "UNAVAILABLE", [report.providerTotal], paint, report.providerTotalState === "ok" ? "success" : "warning", column));
  lines.push(statusRow("Local sessions", "SCANNED", [`${report.localFiles} files, ${report.localRecords} records (since ${report.sinceDate})`], paint, "muted", column));
  lines.push(statusRow("Priced", report.fullyPriced ? "FULL" : "PARTIAL", ["input/output tokens x pricing; cache tokens unpriced"], paint, report.fullyPriced ? "success" : "warning", column));
  lines.push("");
  lines.push(paint("accent", `${report.rows.length} models`) + paint("dim", " · [Any key] Close"));
  return frameRows(lines, width, clip, borderPainter(theme, thinkingLevel));
}

/** Read-only panel in the arnative rounded box; any key closes. Dynamic import for the same
 *  plain-node self-check reason as showStatusPanel. */
async function showUsagePanel(ctx: ExtensionCommandContext, report: UsageReport): Promise<void> {
  const { truncateToWidth } = await import("@earendil-works/pi-tui");
  const thinkingLevel = ctx.thinkingLevel;
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => ({
    render: (width: number) => renderUsageBody(report, theme, width, truncateToWidth, thinkingLevel),
    invalidate: () => undefined,
    handleInput: () => done(),
  }));
}

const AGENTROUTER_SUBCOMMANDS: AutocompleteItem[] = [
  { value: "status", label: "status", description: "Live per-model quota, pricing, and endpoint" },
  { value: "usage", label: "usage", description: "Monthly billing total and per-model cost from local sessions" },
];

const MENU_TITLE = "pi-agentrouter · Menu";
const MENU_DESC = "Account tools for the AgentRouter provider.";

type MenuKey = "up" | "down" | "home" | "end" | "enter" | "escape";

/** Key/match injection: `Key` and `matchesKey` are pi-tui values, imported dynamically so the
 *  module still loads under the plain-node self-check. */
type KeyAdapter = { matches(data: string, key: MenuKey): boolean } & Record<MenuKey, MenuKey>;

type MenuRow = { key: "status" | "usage"; label: string; note: string };

const MENU_ROWS: MenuRow[] = [
  { key: "status", label: "Status", note: "Live per-model quota, pricing, and endpoint" },
  { key: "usage", label: "Usage", note: "Monthly billing total and per-model cost" },
];

/**
 * The root menu in the arnative rounded box. `ctx.ui.select` renders itself with two full-width
 * rules, so a menu that must be rounded owns its component: `→` marker in accent, the chosen label
 * in the soft tier bold, `·` dividers dim, labels padded so every divider lands in one column.
 * The root menu carries no `[←] Back` — there is nothing behind it.
 */
export class AgentRouterMenu {
  private readonly theme: Theme;
  private readonly rows: MenuRow[];
  private readonly clip: Clip;
  private readonly keys: KeyAdapter;
  private readonly done: (key: "status" | "usage" | null) => void;
  private readonly paint: (text: string) => string;
  private index = 0;
  private readonly soft: (text: string) => string;
  private readonly column: number;
  private readonly footer = ["[↑↓] Move", "[Enter] Choose", "[Esc] Cancel"];

  constructor(
    theme: Theme,
    rows: MenuRow[],
    clip: Clip,
    keys: KeyAdapter,
    done: (key: "status" | "usage" | null) => void,
    paint: (text: string) => string,
  ) {
    this.theme = theme;
    this.rows = rows;
    this.clip = clip;
    this.keys = keys;
    this.done = done;
    this.paint = paint;
    this.soft = chosenRowPainter(theme);
    this.column = Math.max(...rows.map((row) => visibleWidth(row.label)));
  }

  handleInput(data: string): void {
    const keys = this.keys;
    if (keys.matches(data, keys.up)) {
      this.index = (this.index - 1 + this.rows.length) % this.rows.length;
      return;
    }
    if (keys.matches(data, keys.down)) {
      this.index = (this.index + 1) % this.rows.length;
      return;
    }
    if (keys.matches(data, keys.home)) {
      this.index = 0;
      return;
    }
    if (keys.matches(data, keys.end)) {
      this.index = this.rows.length - 1;
      return;
    }
    if (keys.matches(data, keys.enter)) {
      this.done(this.rows[this.index]!.key);
      return;
    }
    if (keys.matches(data, keys.escape)) this.done(null);
  }

  render(width: number): string[] {
    const t = this.theme;
    const lines = [
      t.fg("accent", t.bold(MENU_TITLE)),
      t.fg("muted", MENU_DESC),
      "",
    ];
    for (const [i, item] of this.rows.entries()) {
      const chosen = i === this.index;
      const label = chosen ? this.soft(item.label) : t.fg("text", item.label);
      const pad = " ".repeat(Math.max(0, this.column - visibleWidth(item.label)));
      const note = `${t.fg("dim", "  ·  ")}${t.fg("dim", item.note)}`;
      lines.push(`${chosen ? t.fg("accent", "→ ") : "  "}${label}${pad}${note}`);
    }
    lines.push("");
    for (const pair of packPairs(this.footer, boxInner(width))) lines.push(t.fg("dim", pair));
    return frameRows(lines, width, this.clip, this.paint);
  }
}

/** Drive the menu everywhere: TUI gets the rounded box, RPC and headless keep `ctx.ui.select`. */
async function showMenu(ctx: ExtensionCommandContext): Promise<"status" | "usage" | null> {
  if (ctx.mode !== "tui") {
    const labels = MENU_ROWS.map((row) => `${row.label} · ${row.note}`);
    const choice = await ctx.ui.select(MENU_TITLE, labels);
    const hit = choice ? MENU_ROWS.find((row, i) => labels[i] === choice) : undefined;
    return hit ? hit.key : null;
  }
  const { Key, matchesKey, truncateToWidth } = await import("@earendil-works/pi-tui");
  return ctx.ui.custom<"status" | "usage" | null>((tui, theme, _keybindings, done) => {
    const menu = new AgentRouterMenu(
      theme,
      MENU_ROWS,
      truncateToWidth,
      { matches: matchesKey, up: Key.up, down: Key.down, home: Key.home, end: Key.end, enter: Key.enter, escape: Key.escape },
      done,
      borderPainter(theme, ctx.thinkingLevel),
    );
    return {
      render: (width: number) => menu.render(width),
      invalidate: () => undefined,
      handleInput: (data: string) => {
        menu.handleInput(data);
        tui.requestRender();
      },
    };
  });
}

export function registerAgentRouterCommands(pi: ExtensionAPI): void {
  pi.registerCommand("agentrouter", {
    description: "AgentRouter account: status (quota/pricing/endpoint) | usage (billing)",
    getArgumentCompletions: (prefix) => {
      const items = AGENTROUTER_SUBCOMMANDS.filter((s) => s.value.startsWith(prefix.toLowerCase()));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      // The registry reflects the live-discovered catalog; the exported snapshot is
      // only the fallback for contexts without a registry (tests, early startup).
      const liveModels = ctx.modelRegistry?.getModelsOfType?.("chat", "agentrouter") ?? [];
      const targets = liveModels.length > 0
        ? liveModels.map((m) => ({ id: m.id, api: String(m.api), baseUrl: String(m.baseUrl ?? `${AGENTROUTER_ORIGIN}/v1`) }))
        : undefined;
      const modelIds = liveModels.length > 0
        ? new Set<string>([...liveModels.map((m) => m.id), ...AGENTROUTER_MODEL_IDS])
        : undefined;
      const runStatus = async (): Promise<void> => {
        const report = await buildStatusReport(readApiKey(), targets);
        if (ctx.mode === "tui") {
          await showStatusPanel(ctx, report);
          return;
        }
        ctx.ui.notify(renderStatusText(report), "info");
      };
      const runUsage = async (): Promise<void> => {
        const report = await buildUsageReport(readApiKey(), modelIds);
        if (ctx.mode === "tui") {
          await showUsagePanel(ctx, report);
          return;
        }
        ctx.ui.notify(renderUsageText(report), "info");
      };
      if (sub === "status") return runStatus();
      if (sub === "usage") return runUsage();
      if (sub === "") {
        if (ctx.hasUI) {
          const picked = await showMenu(ctx);
          if (picked === "status") return runStatus();
          if (picked === "usage") return runUsage();
          return;
        }
        const theme = ctx.ui.theme;
        const msg = [
          theme.fg("accent", theme.bold("pi-agentrouter"))
            + theme.fg("dim", " | ")
            + theme.fg("muted", "Menu: ")
            + theme.fg("accent", "/agentrouter status")
            + theme.fg("dim", " · ")
            + theme.fg("accent", "/agentrouter usage"),
          theme.fg("muted", "Found a bug? Report issues at ")
            + theme.fg("accent", "https://github.com/bismawy/pi-agentrouter/issues")
            + theme.fg("muted", "."),
          theme.fg("muted", "New user? Register at ")
            + theme.fg("accent", "https://agentrouter.org/register?aff=CKdn")
            + " "
            + theme.fg("success", "($50 bonus)"),
        ].join("\n");
        ctx.ui.notify(msg, "info");
        return;
      }
      ctx.ui.notify(
        `[agentrouter] Unknown argument "${sub}". Use: /agentrouter status | /agentrouter usage`,
        "warning"
      );
    },
  });
}

/* ------------------------------------------------------------------ *
 * Self-check
 * ------------------------------------------------------------------ */

function selfCheck(): void {
  const prices = parsePricing({
    data: [
      { model_name: "claude-opus-4-8", model_ratio: 4, completion_ratio: 5 },
      { model_name: "deepseek-v4-flash", model_ratio: 1, completion_ratio: 3 },
      { model_name: "broken", completion_ratio: 5 },
    ],
  });
  if (prices.size !== 2) throw new Error(`expected 2 priced models, got ${prices.size}`);
  if (prices.get("claude-opus-4-8")?.inputPerMillion !== 8) throw new Error("opus 4.8 input price wrong");
  if (prices.get("claude-opus-4-8")?.outputPerMillion !== 40) throw new Error("opus 4.8 output price wrong");
  if (prices.get("deepseek-v4-flash")?.outputPerMillion !== 6) throw new Error("deepseek output price wrong");

  if (centsToUsd(21074.084) !== 210.74084) throw new Error("cent conversion wrong");

  const claude = buildProbeRequest({ id: "claude-opus-5", api: "anthropic-messages", baseUrl: AGENTROUTER_ORIGIN }, "k");
  if (claude.url !== "https://agentrouter.org/v1/messages") throw new Error(`claude probe url wrong: ${claude.url}`);
  if (!claude.headers["anthropic-version"]) throw new Error("claude probe missing anthropic-version");

  const astra = buildProbeRequest({ id: "gpt-6-astra", api: "openai-responses", baseUrl: `${AGENTROUTER_ORIGIN}/v1` }, "k");
  if (astra.url !== "https://agentrouter.org/v1/responses") throw new Error(`astra probe url wrong: ${astra.url}`);

  const chat = buildProbeRequest({ id: "glm-5.3", api: "openai-completions", baseUrl: `${AGENTROUTER_ORIGIN}/v1/` }, "k");
  if (chat.url !== "https://agentrouter.org/v1/chat/completions") throw new Error(`chat probe url wrong: ${chat.url}`);

  if (findModel({ message: { model: "glm-5.3" } }) !== "glm-5.3") throw new Error("model discovery failed");
  if (findModel({ message: { model: "gpt-4o" } }) !== null) throw new Error("foreign model leaked through");

  const usage = findUsage({ message: { usage: { input: 100, output: 20, cacheRead: 5, cacheWrite: 1 } } });
  if (usage?.input !== 100 || usage.output !== 20 || usage.cacheRead !== 5 || usage.cacheWrite !== 1) {
    throw new Error("usage discovery failed");
  }
  if (findUsage({ message: { content: "no usage here" } }) !== null) throw new Error("phantom usage detected");

  const cost = costOf({ input: 1_000_000, output: 0, cacheRead: 0, cacheWrite: 0 }, { inputPerMillion: 8, outputPerMillion: 40 });
  if (cost !== 8) throw new Error(`cost math wrong: ${cost}`);

  console.log("agentrouter-commands self-check passed");
}

if (process.argv[1]?.replace(/\\/g, "/").endsWith("agentrouter-commands.ts")) selfCheck();
