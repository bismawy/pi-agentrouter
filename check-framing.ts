/** Self-check against the actual extension hooks. Run: bun ./check-framing.ts */
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";
import { AGENTROUTER_PROBE_TARGETS, renderStatusBody, renderUsageBody } from "./agentrouter-commands.ts";

// Loose wire payloads intentionally include missing/null fields from real requests.
type Wire = Record<string, any>;
const hooks = new Map<string, (event: Wire, ctx: Wire) => any>();
const commands = new Map<string, Wire>();
let provider: Wire = {};
register({
  registerProvider(name: string, config: Wire) {
    assert.equal(name, "agentrouter");
    provider = config;
  },
  registerCommand(name: string, options: Wire) {
    assert.ok(!commands.has(name), `duplicate command ${name}`);
    commands.set(name, options);
  },
  on(name: string, handler: (event: Wire, ctx: Wire) => any) {
    hooks.set(name, handler);
  },
} as unknown as ExtensionAPI);

// PROBE_TARGETS_DRIFT_CHECK: commands and probe targets must stay in step with the
// registered provider - drift would make /agentrouter status probe an endpoint the
// model never uses, or advertise a command that does not exist.
assert.deepEqual([...commands.keys()].sort(), ["agentrouter"]);
for (const [name, options] of commands) {
  assert.equal(typeof options.handler, "function", `${name} needs a handler`);
  assert.ok(options.description, `${name} needs a description`);
}
// Subcommand completions must cover exactly the accepted arguments.
assert.deepEqual(
  (commands.get("agentrouter")!.getArgumentCompletions!("") ?? []).map((i) => i.value),
  ["status", "usage"]
);
// Dispatch check: bad input is rejected locally, without touching the network.
const notices: string[] = [];
const probeCtx = {
  ui: {
    notify: (message: string) => notices.push(message),
    theme: {
      fg: (_c: string, text: string) => text,
      bold: (text: string) => text,
    },
  },
};
await commands.get("agentrouter")!.handler("bogus", probeCtx);
assert.match(notices.at(-1)!, /Unknown argument "bogus"/);
await commands.get("agentrouter")!.handler("", probeCtx);
assert.match(notices.at(-1)!, /pi-agentrouter \| Menu:/);
assert.match(notices.at(-1)!, /github\.com\/bismawy\/pi-agentrouter\/issues/);
assert.match(notices.at(-1)!, /\$50 bonus/);

// STATUS_PANEL_CHECK: the panel is a fixed-width table, so every line must fit the
// width, colour must follow meaning, and a long provider error must be clipped.
type Report = Parameters<typeof renderStatusBody>[0];
const stripAnsi = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");
const colorsUsed = new Set<string>();
const fakeTheme = {
  fg: (color: string, text: string) => {
    colorsUsed.add(color);
    return text;
  },
  bold: (text: string) => text,
} as unknown as Parameters<typeof renderStatusBody>[1];
const statusPanel = {
  keyMissing: false,
  pricingState: "live",
  pricingNote: "live, refreshed now (snapshot TTL 24h)",
  rows: [
    { id: "gpt-6-astra", api: "openai-responses", state: "ready", detail: "ready", price: { inputPerMillion: 4, outputPerMillion: 20 } },
    {
      id: "glm-5.3",
      api: "openai-completions",
      state: "error",
      detail: "HTTP 503: 当前分组 default 下对于模型 glm-5.3 无可用渠道 (request id: 20260922192743640594808h4fpkV1XoX1Mn)",
      price: null,
    },
    { id: "claude-opus-5", api: "anthropic-messages", state: "quota", detail: "quota exhausted (402)", price: { inputPerMillion: 6, outputPerMillion: 30 } },
  ],
} as unknown as Report;

// Display width, not string length: the provider errors are Chinese, and a wide
// glyph that is counted as one column is how a panel line ends up overflowing.
const displayWidth = (text: string) =>
  [...text].reduce((sum, ch) => sum + (/[\u1100-\u115f\u2e80-\ua4cf\uac00-\ud7a3\uf900-\ufaff\ufe30-\ufe4f\uff00-\uff60]/u.test(ch) ? 2 : 1), 0);
const plainClip = (text: string, width: number) => {
  let out = "";
  for (const ch of text) {
    if (displayWidth(out + ch) > width - 1) return out + "…";
    out += ch;
  }
  return out;
};
const renderPanel = (width: number) => renderStatusBody(statusPanel, fakeTheme, width, plainClip).map(stripAnsi);

for (const width of [140, 60, 40]) {
  const overflow = renderPanel(width).find((line) => displayWidth(line) > width);
  assert.equal(overflow, undefined, `panel line overflows ${width}: ${overflow}`);
  assert.ok(renderPanel(width).some((line) => line.includes("glm-5.3")), `model row missing at width ${width}`);
}
// A wide panel shows the status column in full; only the long error is clipped.
const wide = renderPanel(140);
assert.ok(wide.some((line) => line.trimEnd().endsWith("ready")), "ready row must not be clipped at full width");
assert.ok(wide.some((line) => line.includes("quota exhausted (402)")), "short statuses must survive at full width");
assert.ok(renderPanel(60).some((line) => line.endsWith("…")), "long error detail must be clipped");
for (const color of ["accent", "dim", "muted", "success", "warning", "error"]) {
  assert.ok(colorsUsed.has(color), `panel never uses the "${color}" theme colour`);
}
const keyMissing = renderStatusBody(
  { keyMissing: true, rows: [], pricingNote: "no API key", pricingState: "missing" } as unknown as Report,
  fakeTheme,
  80,
  plainClip,
).map(stripAnsi).join("\n");
assert.match(keyMissing, /no API key/);

// USAGE_PANEL_CHECK: usage report renders cleanly with identical theme framing
type UsageRep = Parameters<typeof renderUsageBody>[0];
const sampleUsage: UsageRep = {
  month: "September 2026",
  providerTotal: "$12.45",
  providerTotalState: "ok",
  localFiles: 4,
  localRecords: 12,
  sinceDate: "2026-09-01",
  rows: [
    {
      model: "claude-opus-5",
      usage: { input: 20000, output: 5000, cacheRead: 10000, cacheWrite: 0 },
      cost: 0.27,
    },
  ],
  totalCost: 0.27,
  fullyPriced: true,
};

for (const width of [120, 60, 45]) {
  const lines = renderUsageBody(sampleUsage, fakeTheme, width, plainClip).map(stripAnsi);
  const overflow = lines.find((line) => displayWidth(line) > width);
  assert.equal(overflow, undefined, `usage line overflows ${width}: ${overflow}`);
  assert.ok(lines.some((l) => l.includes("claude-opus-5")), "model row missing in usage panel");
}
assert.ok(renderUsageBody(sampleUsage, fakeTheme, 100, plainClip).map(stripAnsi).some((l) => l.includes("$12.45")), "provider total shown");
const registered = new Map<string, { api: string; baseUrl: string }>(
  (provider.models as Wire[]).map((m) => [
    m.id as string,
    { api: (m.api ?? provider.api) as string, baseUrl: (m.baseUrl ?? provider.baseUrl) as string },
  ]),
);
assert.equal(AGENTROUTER_PROBE_TARGETS.length, registered.size, "probe target count drift");
for (const target of AGENTROUTER_PROBE_TARGETS) {
  const actual = registered.get(target.id);
  assert.ok(actual, `probe target ${target.id} is not a registered model`);
  assert.equal(actual.api, target.api, `${target.id}: api drift`);
  assert.equal(actual.baseUrl, target.baseUrl, `${target.id}: baseUrl drift`);
}
// Translator stub: stands in for the user's own provider (agentrouter itself
// would block the Indonesian text we hand it). Deterministic so assertions can
// compare exact strings, and counted so the cache can be proven.
const TRANSLATOR = { provider: "antigravity", id: "gemini-flash" };
let translatorCalls = 0;
const modelRegistry = {
  getAvailable: () => [{ provider: "agentrouter", id: "glm-5.3" }, TRANSLATOR],
  find: (_provider: string, id: string) => (id === TRANSLATOR.id ? TRANSLATOR : undefined),
  streamSimple: (model: Wire, context: Wire) => {
    translatorCalls++;
    const prompt = String(context.messages[0].content);
    const text = prompt.slice(prompt.lastIndexOf("\n\n") + 2);
    return { result: async () => ({ content: [{ type: "text", text: `[EN] ${text}` }] }) };
  },
};
const ctx = { model: { provider: "agentrouter" }, modelRegistry, ui: { notify() {} } };
async function request(payload: Wire): Promise<Wire> {
  assert.equal(await hooks.get("before_provider_request")!({ payload }, ctx), undefined);
  return payload;
}
function blocked(errorMessage = "content-blocked") {
  const result = hooks.get("message_end")!({
    message: { role: "assistant", provider: "agentrouter", stopReason: "error", errorMessage },
  }, ctx);
  assert.match(result.message.errorMessage, /provider.?returned.?error/i);
}
const HEADER = "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
const PREAMBLE = "[Instruction: You are an expert coding assistant operating inside pi. Please carefully analyze the technical context, understand the user request, follow all project instructions and coding standards, and respond thoroughly in the requested language.]";
const NOTE = "[Message withheld by local policy]";
assert.doesNotMatch(NOTE, /sensitive|blocked/i);

const astra = provider.models.find((m: Wire) => m.id === "gpt-6-astra");
assert.ok(astra, "GPT-6 Astra must be registered");
assert.equal(astra.api, "openai-responses");
assert.equal(astra.reasoning, true);
assert.equal(astra.thinkingLevelMap.xhigh, "xhigh");
assert.deepEqual(astra.input, ["text", "image"]);
assert.equal(provider.api, "openai-completions");
assert.equal(provider.models.length, 6);
// pi ignores provider-level compat for extension providers — it must live on each model,
// and the provider must stay self-sufficient without pi-auto-compat's modelOverrides.
assert.equal(provider.compat, undefined);
for (const m of provider.models) {
  assert.equal(m.compat?.sendSessionAffinityHeaders, true, `${m.id}: session affinity must be per-model`);
  assert.equal(m.compat?.supportsLongCacheRetention, true, `${m.id}: long cache retention must be declared`);
}
for (const id of ["claude-opus-4-8", "claude-opus-5"]) {
  const claude = provider.models.find((m: Wire) => m.id === id);
  assert.equal(claude.compat?.forceAdaptiveThinking, true, `${id}: adaptive thinking must be declared on proxy models`);
}
assert.equal(provider.models.find((m: Wire) => m.id === "claude-opus-5").api, "anthropic-messages");
const foreign = { model: "gpt-6-astra", input: [{ role: "user", content: "hello" }] };
const foreignSaved = structuredClone(foreign);
hooks.get("before_provider_request")!({ payload: foreign }, { model: { provider: "openai-codex" } });
assert.deepEqual(foreign, foreignSaved, "same model on another provider must not be modified");

for (const field of ["messages", "input"]) {
  const type = field === "input" ? "input_text" : "text";
  for (const prompt of [`AGENTS.md\n\n${HEADER}\n\nMore.`, `${HEADER}\n\nrest`, "Local rules.", []]) {
    const payload = await request({ [field]: [{ role: "developer", content: structuredClone(prompt) }] });
    const system = payload[field][0];
    assert.equal(system.role, "system");
    if (Array.isArray(system.content)) assert.equal(system.content[0].type, type);
    const text = Array.isArray(system.content) ? system.content[0].text : system.content;
    assert.ok(text.startsWith(HEADER));
    if (typeof prompt === "string") assert.ok(text.includes(prompt.split("\n")[0]));
    const before = structuredClone(payload);
    await request(payload);
    assert.deepEqual(payload, before, "root prompt must be idempotent");
  }
  for (const content of ["halo", [], [{ type, text: "halo" }], [{ type: field === "input" ? "input_image" : "image", image_url: "https://example.com/test.png" }]]) {
    const source = [{ role: "user", content }];
    const original = structuredClone(source);
    const payload = await request({ [field]: source });
    assert.deepEqual(source, original, "framing must not mutate session messages");
    const framed = payload[field][0].content;
    if (Array.isArray(framed)) {
      assert.equal(framed[0].type, type);
      assert.ok(framed[0].text.startsWith(PREAMBLE));
    } else assert.ok(framed.startsWith(PREAMBLE));
    const before = structuredClone(payload);
    await request(payload);
    assert.deepEqual(payload, before, "user framing must be idempotent");
  }
}
assert.equal((await request({ input: "halo", instructions: "Local rules." })).input, `${PREAMBLE}\n\nhalo`);
assert.ok((await request({ input: [], instructions: "Local rules." })).instructions.startsWith(HEADER));
const anthropic = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }];
assert.deepEqual((await request({ messages: structuredClone(anthropic) })).messages, anthropic);
assert.equal((await request({ messages: [{ role: "user", content: "a\u001b[31mb\u0000\ud800" }] })).messages[0].content, `${PREAMBLE}\n\nab`);

// Responses reasoning/reference/function items have no role or content.
const history: Wire[] = [
  { role: "system", content: HEADER },
  { role: "user", content: [{ type: "input_text", text: "old question" }] },
  { type: "reasoning", id: "rs_1", encrypted_content: "opaque", summary: [] },
  { type: "item_reference", id: "msg_ref" },
  { type: "function_call", call_id: "call_old", name: "lookup", arguments: '{"city":"Tokyo"}' },
  { type: "function_call_output", call_id: "call_old", output: "old result" },
  { role: "assistant", content: [{ type: "output_text", text: "old answer", annotations: [] }] },
  { role: "user", content: [{ type: "input_text", text: "new question" }] },
  { type: "function_call", call_id: "call_new", name: "lookup", arguments: '{"city":"Kyoto"}' },
  { type: "function_call_output", call_id: "call_new", output: "new result" },
];
const saved = structuredClone(history);
const normal = await request({ input: history });
assert.deepEqual(history, saved);
assert.deepEqual(normal.input.slice(2, 6), saved.slice(2, 6));
blocked();
const stage1 = await request({ input: history });
assert.equal(stage1.input[1].content[0].text, `${PREAMBLE}\n\n${NOTE}`);
assert.equal(stage1.input[6].content[0].text, "old answer");
assert.deepEqual(stage1.input.slice(7), normal.input.slice(7));
const sticky = await request({ input: history });
assert.deepEqual(sticky, stage1);
blocked();
const stage2 = await request({ input: history });
assert.equal(stage2.input[4].arguments, "{}");
assert.equal(stage2.input[5].output, NOTE);
assert.equal(stage2.input[6].content[0].text, NOTE);
assert.equal(stage2.input[6].content[0].type, "output_text");
assert.equal(stage2.input[4].call_id, stage2.input[5].call_id);
assert.deepEqual(stage2.input.slice(2, 4), saved.slice(2, 4), "reasoning and references stay intact");
assert.deepEqual(stage2.input.slice(7), normal.input.slice(7), "latest turn and its tools stay intact");
assert.deepEqual(history, saved, "redaction must not mutate session history");

// Multimodal function output redacts text without changing images or block types.
const multimodal = structuredClone(history);
multimodal[5].output = [{ type: "input_text", text: "old output text" }, { type: "input_image", image_url: "https://example.com/test.png" }];
await request({ input: multimodal });
blocked("sensitive_words_detected");
const multimodalResult = await request({ input: multimodal });
assert.equal(multimodalResult.input[5].output[0].text, NOTE);
assert.equal(multimodalResult.input[5].output[0].type, "input_text");
assert.deepEqual(multimodalResult.input[5].output[1], multimodal[5].output[1]);
assert.equal(multimodal[5].output[0].text, "old output text");

// Same-type tool items must have distinct sticky fingerprints; new history stays visible.
const extended = [...history, { role: "user", content: "next question" }];
const extendedResult = await request({ input: extended });
assert.equal(extendedResult.input[8].arguments, saved[8].arguments);
assert.equal(extendedResult.input[9].output, saved[9].output);
const fresh = await request({ input: [{ role: "user", content: "fresh session" }] });
assert.equal(fresh.input[0].content, `${PREAMBLE}\n\nfresh session`);
await request({ input: history });
blocked("sensitive_words_detected");
assert.deepEqual(await request({ input: history }), stage2, "sensitive error redacts older turns in one pass");

// Chat Completions null/missing content, nested tool calls, and error pruning.
const chat: Wire[] = [
  { role: "system", content: HEADER },
  { role: "user", content: "chat question" },
  { role: "assistant", content: null, tool_calls: [{ id: "c1", type: "function", function: { name: "lookup", arguments: '{"city":"Tokyo"}' } }] },
  { role: "tool", tool_call_id: "c1", content: "tool output" },
  { role: "assistant" },
  { role: "assistant", content: "failed", stopReason: "error" },
  { role: "user", content: "continue chat" },
];
await request({ messages: chat });
blocked("sensitive_words_detected");
const chatSaved = structuredClone(chat);
const redacted = (await request({ messages: chat })).messages;
assert.equal(redacted.length, 6);
assert.equal(redacted[2].tool_calls[0].function.arguments, "{}");
assert.equal(redacted[3].content, NOTE);
assert.equal(redacted.at(-1).content, `${PREAMBLE}\n\ncontinue chat`);
assert.deepEqual(chat, chatSaved);

// Anthropic nested tool results keep pairing and source objects during escalation.
const turns: Wire[] = [
  { role: "user", content: "anthropic question" },
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "lookup", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "result" }] }] },
  { role: "user", content: "continue anthropic" },
];
await request({ messages: turns });
blocked();
const turnsSaved = structuredClone(turns);
const result = (await request({ messages: turns })).messages;
assert.equal(result[2].content[0].content[0].text, NOTE);
assert.equal(result[2].content[0].type, "tool_result");
assert.equal(result[2].content[0].tool_use_id, result[1].content[0].id);
assert.deepEqual(turns, turnsSaved);

// --- On-demand translation ---------------------------------------------------
// When there is nothing older to redact the newest turn is the trigger, and it
// used to be a dead end. Measured against the live gateway: the Indonesian
// message alone returns 400 content-blocked while its translation returns 200.
const ID_PREAMBLE = PREAMBLE.replace(
  "respond thoroughly in the requested language",
  "respond thoroughly in Indonesian",
);
const ID_TURN = "Tolong jelaskan bagaimana antrean pesan ini bekerja di dalam aplikasi.";
const firstTurn: Wire[] = [{ role: "user", content: ID_TURN }];

const plain = await request({ messages: structuredClone(firstTurn) });
assert.equal(plain.messages[0].content, `${PREAMBLE}\n\n${ID_TURN}`, "no translation before a block");
blocked();
const callsBefore = translatorCalls;
const translated = await request({ messages: firstTurn });
assert.equal(translated.messages[0].content, `${ID_PREAMBLE}\n\n[EN] ${ID_TURN}`);
assert.equal(translatorCalls, callsBefore + 1);
assert.equal(firstTurn[0].content, ID_TURN, "session history must stay Indonesian");

// Sticky: the turn stays English on the next request, without a second call.
const again = await request({ messages: structuredClone(firstTurn) });
assert.equal(again.messages[0].content, `${ID_PREAMBLE}\n\n[EN] ${ID_TURN}`);
assert.equal(translatorCalls, callsBefore + 1, "cached translation must not re-call the model");

// A translation that still gets blocked must stop retrying, not loop forever.
const giveUp = hooks.get("message_end")!({
  message: { role: "assistant", provider: "agentrouter", stopReason: "error", errorMessage: "content-blocked" },
}, ctx);
assert.equal(giveUp, undefined, "no further retry once translation was tried");

// English turns and fenced code are left alone.
const englishTurn: Wire[] = [{ role: "user", content: "Explain the message queue in this app." }];
const englishResult = await request({ messages: englishTurn });
assert.equal(englishResult.messages[0].content, `${PREAMBLE}\n\nExplain the message queue in this app.`);
const codeTurn: Wire[] = [{
  role: "user",
  content: "Jelaskan berkas ini untuk saya.\n```js\nconst a = 1; // jangan diubah\n```\nJelaskan juga bagian penutupnya.",
}];
await request({ messages: structuredClone(codeTurn) });
blocked();
const codeResult = await request({ messages: codeTurn });
assert.equal(
  codeResult.messages[0].content,
  `${ID_PREAMBLE}\n\n[EN] Jelaskan berkas ini untuk saya.\n\`\`\`js\nconst a = 1; // jangan diubah\n\`\`\`\n[EN] Jelaskan juga bagian penutupnya.`,
  "prose translated, fenced code verbatim, layout preserved",
);

console.log("ok: model registration, framing, Responses items, redaction, translation, and legacy protocols");
