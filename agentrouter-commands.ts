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
import type { AutocompleteItem, Component } from "@earendil-works/pi-tui";
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
 * Probe targets mirror the provider's model list. `check-framing.ts` asserts
 * these stay in sync with the registered models, so drift fails a test rather
 * than silently reporting the wrong endpoint.
 */
export const AGENTROUTER_PROBE_TARGETS = [
  { id: "gpt-6-astra", api: "openai-responses", baseUrl: `${AGENTROUTER_ORIGIN}/v1` },
  { id: "gpt-5.6-sol", api: "openai-completions", baseUrl: `${AGENTROUTER_ORIGIN}/v1` },
  { id: "deepseek-v4-flash", api: "openai-completions", baseUrl: `${AGENTROUTER_ORIGIN}/v1` },
  { id: "glm-5.3", api: "openai-completions", baseUrl: `${AGENTROUTER_ORIGIN}/v1` },
  { id: "claude-opus-4-8", api: "anthropic-messages", baseUrl: AGENTROUTER_ORIGIN },
  { id: "claude-opus-5", api: "anthropic-messages", baseUrl: AGENTROUTER_ORIGIN },
] as const;

const AGENTROUTER_MODEL_IDS = new Set<string>(AGENTROUTER_PROBE_TARGETS.map((t) => t.id));

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

export function findModel(node: unknown, depth = 0): string | null {
  if (depth > 8) return null;
  if (typeof node === "string") return AGENTROUTER_MODEL_IDS.has(node) ? node : null;
  if (Array.isArray(node)) {
    for (const item of node) {
      const hit = findModel(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  if (!isRecord(node)) return null;
  for (const value of Object.values(node)) {
    const hit = findModel(value, depth + 1);
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
export function scanSessions(sinceMs: number, filter?: (file: string) => boolean): SessionScan {
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
      const model = findModel(parsed);
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

async function buildStatusReport(apiKey: string | null): Promise<StatusReport> {
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

  const results = await Promise.all(AGENTROUTER_PROBE_TARGETS.map((t) => probeModel(t, apiKey)));
  return {
    keyMissing: false,
    rows: results.map((r) => ({ ...r, price: prices.get(r.id) ?? null })),
    pricingNote,
    pricingState,
  };
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
 * The panel body: same data as renderStatusText, one colour per meaning.
 *
 * Clipping happens on plain text, never on a coloured line: escape sequences would
 * count towards the width and slice a column in half. Table rows are assembled from
 * cells already padded to their computed width, so their visible width is exact.
 */
export function renderStatusBody(
  report: StatusReport,
  theme: Theme,
  width: number,
  clip: Clip,
): string[] {
  const pad = " ";
  const fit = (line: string) => clip(pad + line, width);
  const lines: string[] = [
    fit(theme.fg("accent", theme.bold("AgentRouter")) + theme.fg("dim", " · ") + theme.fg("accent", theme.bold("Status"))),
    fit(theme.fg("muted", "Live model availability, pricing, and per-model endpoint.")),
    "",
  ];

  if (report.keyMissing) {
    lines.push(fit(theme.fg("warning", report.pricingNote)), "");
    return [...lines, ...statusLegend(report, theme, width, clip)];
  }

  const widths = statusColumnWidths(report.rows);
  const cells = widths.reduce((sum, w) => sum + w, 0) + widths.length * 2 + pad.length;
  // Narrow terminals squeeze the status column to nothing rather than overflowing;
  // the row is clipped again below as a final guarantee.
  const detailWidth = Math.max(0, width - cells);

  lines.push(fit(theme.fg("muted", theme.bold(STATUS_HEADERS.slice(0, 4).map((h, i) => h.padEnd(widths[i]!)).join("  ") + "  " + STATUS_HEADERS[4]))));
  for (const row of report.rows) {
    const [input, output] = priceLabel(row.price);
    const priceCell = (value: string, w: number) =>
      theme.fg(row.price ? "text" : "muted", value.padEnd(w));
    lines.push(
      fit(
        theme.fg("accent", row.id.padEnd(widths[0]!))
        + "  " + priceCell(input, widths[1]!)
        + "  " + priceCell(output, widths[2]!)
        + "  " + theme.fg("dim", row.api.padEnd(widths[3]!))
        + "  " + theme.fg(statusColor(row.state), clip(row.detail, detailWidth)),
      ),
    );
  }

  const footerLabel = (label: string, value: string, color: "success" | "warning" | "error" | "muted") =>
    fit(theme.fg("dim", label.padEnd(8)) + theme.fg(color, value));
  const pricingColor = report.pricingState === "live" ? "success" : report.pricingState === "stale" ? "warning" : "error";
  lines.push("");
  lines.push(footerLabel("Pricing", report.pricingNote, pricingColor));
  lines.push(footerLabel("Probe", "POST max_tokens=1 per model, on that model's own endpoint", "muted"));
  lines.push(footerLabel("Ready", readyLabel(report), readyColor(report)));
  lines.push("");
  return [...lines, ...statusLegend(report, theme, width, clip)];
}

/** Footer legend in the /vision-watcher picker style: accent count, dim keys. */
function statusLegend(report: StatusReport, theme: Theme, width: number, clip: Clip): string[] {
  const count = report.rows.length ? `${report.rows.length} models` : "no models";
  return [clip(" " + theme.fg("accent", count) + theme.fg("dim", " · [any key] close"), width)];
}

/** Container body for ctx.ui.custom; colours are recomputed on every render. */
class AgentRouterStatusPanel implements Component {
  private readonly report: StatusReport;
  private readonly theme: Theme;
  private readonly clip: Clip;

  constructor(report: StatusReport, theme: Theme, clip: Clip) {
    this.report = report;
    this.theme = theme;
    this.clip = clip;
  }

  render(width: number): string[] {
    return renderStatusBody(this.report, this.theme, width, this.clip);
  }

  invalidate(): void {}
}

/**
 * Read-only panel framed like the /vision-watcher picker: accent border, any key closes.
 *
 * The TUI imports are dynamic because this file's self-check (check-framing.ts) runs
 * under plain node, where `@earendil-works/*` only resolves inside pi.
 */
async function showStatusPanel(ctx: ExtensionCommandContext, report: StatusReport): Promise<void> {
  const [{ DynamicBorder }, { Container, truncateToWidth }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-tui"),
  ]);
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const border = () => new DynamicBorder((s: string) => theme.fg("accent", s));
    const container = new Container();
    container.addChild(border());
    container.addChild(new AgentRouterStatusPanel(report, theme, truncateToWidth));
    container.addChild(border());
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: () => done(),
    };
  });
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

async function buildUsageReport(apiKey: string | null): Promise<UsageReport> {
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
  const scan = scanSessions(monthStartMs(now));

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

export function renderUsageBody(
  report: UsageReport,
  theme: Theme,
  width: number,
  clip: Clip,
): string[] {
  const pad = " ";
  const fit = (line: string) => clip(pad + line, width);
  const lines: string[] = [
    fit(theme.fg("accent", theme.bold("AgentRouter")) + theme.fg("dim", " · ") + theme.fg("accent", theme.bold(`Usage (${report.month})`))),
    fit(theme.fg("muted", "Provider billing total and local session breakdown.")),
    "",
  ];

  if (report.rows.length === 0) {
    lines.push(fit(theme.fg("muted", "(no AgentRouter usage recorded in local sessions this month)")), "");
  } else {
    const widths = usageColumnWidths(report.rows);
    lines.push(fit(theme.fg("muted", theme.bold(USAGE_HEADERS.map((h, i) => h.padEnd(widths[i]!)).join("  ")))));
    for (const row of report.rows) {
      const costStr = row.cost !== null ? usd(row.cost) : "?";
      lines.push(
        fit(
          theme.fg("accent", row.model.padEnd(widths[0]!))
          + "  " + theme.fg("text", tokens(row.usage.input).padEnd(widths[1]!))
          + "  " + theme.fg("text", tokens(row.usage.output).padEnd(widths[2]!))
          + "  " + theme.fg("dim", `${tokens(row.usage.cacheRead)}/${tokens(row.usage.cacheWrite)}`.padEnd(widths[3]!))
          + "  " + theme.fg(row.cost !== null ? "success" : "muted", costStr.padEnd(widths[4]!)),
        ),
      );
    }
    const sumW = widths.slice(0, 4).reduce((sum, w) => sum + w, 0) + 3 * 2;
    lines.push(
      fit(
        theme.fg("muted", theme.bold("TOTAL".padEnd(sumW)))
        + "  " + theme.fg("success", theme.bold(usd(report.totalCost))),
      ),
    );
    lines.push("");
  }

  const footerLabel = (label: string, value: string, color: "success" | "warning" | "error" | "muted") =>
    fit(theme.fg("dim", label.padEnd(16)) + theme.fg(color, value));

  lines.push(footerLabel("Provider total", report.providerTotal, report.providerTotalState === "ok" ? "success" : "warning"));
  lines.push(footerLabel("Local sessions", `${report.localFiles} files, ${report.localRecords} records (since ${report.sinceDate})`, "muted"));
  lines.push("");

  const count = report.rows.length ? `${report.rows.length} models` : "0 models";
  lines.push(clip(" " + theme.fg("accent", count) + theme.fg("dim", " · [any key] close"), width));
  return lines;
}

class AgentRouterUsagePanel implements Component {
  private readonly report: UsageReport;
  private readonly theme: Theme;
  private readonly clip: Clip;

  constructor(report: UsageReport, theme: Theme, clip: Clip) {
    this.report = report;
    this.theme = theme;
    this.clip = clip;
  }

  render(width: number): string[] {
    return renderUsageBody(this.report, this.theme, width, this.clip);
  }

  invalidate(): void {}
}

async function showUsagePanel(ctx: ExtensionCommandContext, report: UsageReport): Promise<void> {
  const [{ DynamicBorder }, { Container, truncateToWidth }] = await Promise.all([
    import("@earendil-works/pi-coding-agent"),
    import("@earendil-works/pi-tui"),
  ]);
  await ctx.ui.custom<void>((tui, theme, _keybindings, done) => {
    const border = () => new DynamicBorder((s: string) => theme.fg("accent", s));
    const container = new Container();
    container.addChild(border());
    container.addChild(new AgentRouterUsagePanel(report, theme, truncateToWidth));
    container.addChild(border());
    return {
      render: (width: number) => container.render(width),
      invalidate: () => container.invalidate(),
      handleInput: () => done(),
    };
  });
}

const AGENTROUTER_SUBCOMMANDS: AutocompleteItem[] = [
  { value: "status", label: "status", description: "Live per-model quota, pricing, and endpoint" },
  { value: "usage", label: "usage", description: "Monthly billing total and per-model cost from local sessions" },
];

export function registerAgentRouterCommands(pi: ExtensionAPI): void {
  pi.registerCommand("agentrouter", {
    description: "AgentRouter account: status (quota/pricing/endpoint) | usage (billing)",
    getArgumentCompletions: (prefix) => {
      const items = AGENTROUTER_SUBCOMMANDS.filter((s) => s.value.startsWith(prefix.toLowerCase()));
      return items.length > 0 ? items : null;
    },
    handler: async (args, ctx) => {
      const sub = args.trim().toLowerCase();
      if (sub === "status") {
        const report = await buildStatusReport(readApiKey());
        if (ctx.hasUI && ctx.mode === "tui") {
          await showStatusPanel(ctx, report);
          return;
        }
        ctx.ui.notify(renderStatusText(report), "info");
        return;
      }
      if (sub === "usage") {
        const report = await buildUsageReport(readApiKey());
        if (ctx.hasUI && ctx.mode === "tui") {
          await showUsagePanel(ctx, report);
          return;
        }
        ctx.ui.notify(renderUsageText(report), "info");
        return;
      }
      ctx.ui.notify(
        sub === ""
          ? "[agentrouter] Use: /agentrouter status | /agentrouter usage"
          : `[agentrouter] Unknown argument "${sub}". Use: status | usage.`,
        sub === "" ? "info" : "warning"
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
