/**
 * AgentRouter accounting commands for pi.
 *
 * Registers:
 *   /agentrouter-status  live per-model quota + pricing + endpoint
 *   /agentrouter-usage   monthly provider billing total + per-model cost
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

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
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
 * network call; /agentrouter-status always fetches live.
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

async function buildStatusReport(apiKey: string | null): Promise<string> {
  const lines: string[] = ["AgentRouter model status", ""];

  if (!apiKey) {
    lines.push("No API key found. Set AGENTROUTER_API_KEY or run /login agentrouter.");
    return lines.join("\n");
  }

  let prices = new Map<string, PricingEntry>();
  let pricingNote = "live";
  try {
    prices = await fetchPricing();
    writePricingCache(prices);
  } catch (error) {
    const cached = readPricingCache();
    prices = new Map(Object.entries(cached?.prices ?? {}));
    const message = error instanceof Error ? error.message : String(error);
    pricingNote = cached
      ? `cached ${new Date(cached.fetchedAt).toISOString()} (live fetch failed: ${message})`
      : `unavailable (${message})`;
  }

  const results = await Promise.all(AGENTROUTER_PROBE_TARGETS.map((t) => probeModel(t, apiKey)));

  lines.push("MODEL               INPUT/1M   OUTPUT/1M   ENDPOINT            STATUS");
  for (const result of results) {
    const price = prices.get(result.id);
    lines.push(
      result.id.padEnd(20)
      + (price ? usd(price.inputPerMillion) : "?").padEnd(11)
      + (price ? usd(price.outputPerMillion) : "?").padEnd(12)
      + result.api.padEnd(20)
      + result.detail,
    );
  }

  lines.push("");
  lines.push(`Pricing: ${pricingNote} (snapshot TTL ${PRICING_TTL_MS / 3_600_000}h)`);
  lines.push("Probe:   POST max_tokens=1 per model, on that model's own endpoint");

  const ready = results.filter((r) => r.state === "ready").length;
  lines.push(`Ready:   ${ready}/${results.length}`);

  return lines.join("\n");
}

async function buildUsageReport(apiKey: string | null): Promise<string> {
  const now = new Date();
  const lines: string[] = [`AgentRouter usage — ${monthLabel(now)}`, ""];

  if (apiKey) {
    const url = `${USAGE_URL}?start_date=${isoDate(new Date(now.getFullYear(), now.getMonth(), 1))}`
      + `&end_date=${isoDate(now)}`;
    try {
      const res = await fetch(url, {
        headers: { Authorization: `Bearer ${apiKey}`, "User-Agent": PROBE_USER_AGENT },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (!res.ok) {
        lines.push(`Provider total: unavailable (HTTP ${res.status})`);
      } else {
        const payload = (await res.json()) as unknown;
        const cents = isRecord(payload) ? numOrNull(payload.total_usage) : null;
        lines.push(cents === null
          ? "Provider total: unavailable (unexpected payload)"
          : `Provider total (billing API): ${usd(centsToUsd(cents))}`);
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      lines.push(`Provider total: unavailable (${message})`);
    }
  } else {
    lines.push("Provider total: unavailable (no API key)");
  }

  const cached = readPricingCache();
  const prices = new Map(Object.entries(cached?.prices ?? {}));
  const scan = scanSessions(monthStartMs(now));

  lines.push(`Local sessions: ${scan.files} file(s) since ${isoDate(new Date(monthStartMs(now)))}, ${scan.records} record(s)`);
  lines.push("");
  lines.push("MODEL               INPUT          OUTPUT         CACHE R/W          COST");
  lines.push("-".repeat(78));

  let total = 0;
  let priced = true;
  const ranked = [...scan.byModel.entries()].sort((a, b) => (costOf(b[1], prices.get(b[0])) ?? 0) - (costOf(a[1], prices.get(a[0])) ?? 0));

  for (const [model, usage] of ranked) {
    const cost = costOf(usage, prices.get(model));
    if (cost === null) priced = false;
    else total += cost;
    lines.push(
      model.padEnd(20)
      + tokens(usage.input).padEnd(15)
      + tokens(usage.output).padEnd(15)
      + `${tokens(usage.cacheRead)}/${tokens(usage.cacheWrite)}`.padEnd(19)
      + (cost === null ? "?" : usd(cost)),
    );
  }

  if (ranked.length === 0) {
    lines.push("(no AgentRouter usage recorded in local sessions this month)");
  } else {
    lines.push("-".repeat(78));
    lines.push("TOTAL".padEnd(69) + usd(total));
  }

  lines.push("");
  // Cache tokens are reported but not priced: AgentRouter publishes no cache rate,
  // and inventing one would misstate the credits used.
  lines.push("Costs are input/output tokens x live pricing; cache tokens are shown but");
  lines.push(`not priced. Provider total is the authoritative monthly figure.`);
  if (!priced) lines.push("Some models had no pricing entry — their cost is shown as ?.");

  return lines.join("\n");
}

export function registerAgentRouterCommands(pi: ExtensionAPI): void {
  pi.registerCommand("agentrouter-status", {
    description: "Show live AgentRouter model status: quota, pricing, and endpoint.",
    handler: async (_args, ctx) => {
      const report = await buildStatusReport(readApiKey());
      ctx.ui.notify(report, "info");
    },
  });

  pi.registerCommand("agentrouter-usage", {
    description: "Show AgentRouter usage: monthly billing total and per-model cost from local sessions.",
    handler: async (_args, ctx) => {
      const report = await buildUsageReport(readApiKey());
      ctx.ui.notify(report, "info");
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
