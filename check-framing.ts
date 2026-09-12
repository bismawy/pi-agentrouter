/** Self-check against the actual extension hooks. Run: bun ./check-framing.ts */
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import register from "./index.ts";

// Loose wire payloads intentionally include missing/null fields from real requests.
type Wire = Record<string, any>;
const hooks = new Map<string, (event: Wire, ctx: Wire) => any>();
let provider: Wire = {};
register({
  registerProvider(name: string, config: Wire) {
    assert.equal(name, "agentrouter");
    provider = config;
  },
  on(name: string, handler: (event: Wire, ctx: Wire) => any) {
    hooks.set(name, handler);
  },
} as unknown as ExtensionAPI);
const ctx = { model: { provider: "agentrouter" }, ui: { notify() {} } };
function request(payload: Wire): Wire {
  assert.equal(hooks.get("before_provider_request")!({ payload }, ctx), undefined);
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
// pi ignores provider-level compat for extension providers — it must live on each model.
assert.equal(provider.compat, undefined);
for (const m of provider.models) {
  assert.equal(m.compat?.sendSessionAffinityHeaders, true, `${m.id}: session affinity must be per-model`);
}
assert.equal(provider.models.find((m: Wire) => m.id === "claude-opus-5").api, "anthropic-messages");
const foreign = { model: "gpt-6-astra", input: [{ role: "user", content: "hello" }] };
const foreignSaved = structuredClone(foreign);
hooks.get("before_provider_request")!({ payload: foreign }, { model: { provider: "openai-codex" } });
assert.deepEqual(foreign, foreignSaved, "same model on another provider must not be modified");

for (const field of ["messages", "input"]) {
  const type = field === "input" ? "input_text" : "text";
  for (const prompt of [`AGENTS.md\n\n${HEADER}\n\nMore.`, `${HEADER}\n\nrest`, "Local rules.", []]) {
    const payload = request({ [field]: [{ role: "developer", content: structuredClone(prompt) }] });
    const system = payload[field][0];
    assert.equal(system.role, "system");
    if (Array.isArray(system.content)) assert.equal(system.content[0].type, type);
    const text = Array.isArray(system.content) ? system.content[0].text : system.content;
    assert.ok(text.startsWith(HEADER));
    if (typeof prompt === "string") assert.ok(text.includes(prompt.split("\n")[0]));
    const before = structuredClone(payload);
    request(payload);
    assert.deepEqual(payload, before, "root prompt must be idempotent");
  }
  for (const content of ["halo", [], [{ type, text: "halo" }], [{ type: field === "input" ? "input_image" : "image", image_url: "https://example.com/test.png" }]]) {
    const source = [{ role: "user", content }];
    const original = structuredClone(source);
    const payload = request({ [field]: source });
    assert.deepEqual(source, original, "framing must not mutate session messages");
    const framed = payload[field][0].content;
    if (Array.isArray(framed)) {
      assert.equal(framed[0].type, type);
      assert.ok(framed[0].text.startsWith(PREAMBLE));
    } else assert.ok(framed.startsWith(PREAMBLE));
    const before = structuredClone(payload);
    request(payload);
    assert.deepEqual(payload, before, "user framing must be idempotent");
  }
}
assert.equal(request({ input: "halo", instructions: "Local rules." }).input, `${PREAMBLE}\n\nhalo`);
assert.ok(request({ input: [], instructions: "Local rules." }).instructions.startsWith(HEADER));
const anthropic = [{ role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] }];
assert.deepEqual(request({ messages: structuredClone(anthropic) }).messages, anthropic);
assert.equal(request({ messages: [{ role: "user", content: "a\u001b[31mb\u0000\ud800" }] }).messages[0].content, `${PREAMBLE}\n\nab`);

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
const normal = request({ input: history });
assert.deepEqual(history, saved);
assert.deepEqual(normal.input.slice(2, 6), saved.slice(2, 6));
blocked();
const stage1 = request({ input: history });
assert.equal(stage1.input[1].content[0].text, `${PREAMBLE}\n\n${NOTE}`);
assert.equal(stage1.input[6].content[0].text, "old answer");
assert.deepEqual(stage1.input.slice(7), normal.input.slice(7));
const sticky = request({ input: history });
assert.deepEqual(sticky, stage1);
blocked();
const stage2 = request({ input: history });
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
request({ input: multimodal });
blocked("sensitive_words_detected");
const multimodalResult = request({ input: multimodal });
assert.equal(multimodalResult.input[5].output[0].text, NOTE);
assert.equal(multimodalResult.input[5].output[0].type, "input_text");
assert.deepEqual(multimodalResult.input[5].output[1], multimodal[5].output[1]);
assert.equal(multimodal[5].output[0].text, "old output text");

// Same-type tool items must have distinct sticky fingerprints; new history stays visible.
const extended = [...history, { role: "user", content: "next question" }];
const extendedResult = request({ input: extended });
assert.equal(extendedResult.input[8].arguments, saved[8].arguments);
assert.equal(extendedResult.input[9].output, saved[9].output);
const fresh = request({ input: [{ role: "user", content: "fresh session" }] });
assert.equal(fresh.input[0].content, `${PREAMBLE}\n\nfresh session`);
request({ input: history });
blocked("sensitive_words_detected");
assert.deepEqual(request({ input: history }), stage2, "sensitive error redacts older turns in one pass");

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
request({ messages: chat });
blocked("sensitive_words_detected");
const chatSaved = structuredClone(chat);
const redacted = request({ messages: chat }).messages;
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
request({ messages: turns });
blocked();
const turnsSaved = structuredClone(turns);
const result = request({ messages: turns }).messages;
assert.equal(result[2].content[0].content[0].text, NOTE);
assert.equal(result[2].content[0].type, "tool_result");
assert.equal(result[2].content[0].tool_use_id, result[1].content[0].id);
assert.deepEqual(turns, turnsSaved);
console.log("ok: model registration, framing, Responses items, redaction, and legacy protocols");
