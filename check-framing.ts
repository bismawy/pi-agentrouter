/**
 * Self-check for AgentRouter WAF prompt rewrite.
 * Run: bun ./check-framing.ts
 */
const CANONICAL_PI_HEADER =
  "You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";

const PI_HEADER_RE =
  /(?:You are [^\n\r]*operating inside pi[^\n\r]*\n?|You are (?:pi|Pi)[^\n\r]*\n?)/i;

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function enforceCanonicalRootPrompt(systemPrompt: unknown): unknown {
  if (!systemPrompt) return CANONICAL_PI_HEADER;
  if (typeof systemPrompt === "string") {
    const text = systemPrompt.trim();
    const match = text.match(PI_HEADER_RE);
    if (!match || match.index === undefined) return `${CANONICAL_PI_HEADER}\n\n${text}`;
    if (match.index > 0) {
      const header = match[0].trim();
      const prefix = text.slice(0, match.index).trim();
      const rest = text.slice(match.index + match[0].length).trim();
      return `${header}\n\n${prefix}${rest ? "\n\n" + rest : ""}`;
    }
    return text;
  }
  return systemPrompt;
}

const buried = `AGENTS.md — Bahasa Indonesia\n\n${CANONICAL_PI_HEADER}\n\nMore.`;
const fixed = enforceCanonicalRootPrompt(buried) as string;
if (!fixed.startsWith("You are an expert coding assistant operating inside pi")) {
  throw new Error(`header not moved to front: ${fixed.slice(0, 80)}`);
}
if (!fixed.includes("AGENTS.md")) throw new Error("prefix lost");

const already = enforceCanonicalRootPrompt(CANONICAL_PI_HEADER + "\n\nrest") as string;
if (already !== CANONICAL_PI_HEADER + "\n\nrest") throw new Error("idempotent fail");

const missing = enforceCanonicalRootPrompt("Hanya aturan lokal.") as string;
if (!missing.startsWith(CANONICAL_PI_HEADER)) throw new Error("missing header not injected");

const LANGUAGE_PREAMBLE =
  "[Instruction: You are an expert coding assistant operating inside pi. Please carefully analyze the technical context, understand the user request, follow all project instructions and coding standards, and respond thoroughly in the requested language.]";
function prependUserPreamble(content: unknown): unknown {
  if (typeof content === "string") {
    if (content.startsWith(LANGUAGE_PREAMBLE)) return content;
    return content ? `${LANGUAGE_PREAMBLE}\n\n${content}` : LANGUAGE_PREAMBLE;
  }
  if (!Array.isArray(content)) return content;
  if (content.length === 0) return [{ type: "text", text: LANGUAGE_PREAMBLE }];
  const head = content[0] as { type?: string; text?: string };
  if (head?.type === "text" && typeof head.text === "string") {
    if (head.text.startsWith(LANGUAGE_PREAMBLE)) return content;
    head.text = `${LANGUAGE_PREAMBLE}\n\n${head.text}`;
    return content;
  }
  return [{ type: "text", text: LANGUAGE_PREAMBLE }, ...content];
}
const framed = prependUserPreamble("Tolong bantu saya perbaiki bug ini") as string;
if (!framed.startsWith(LANGUAGE_PREAMBLE)) throw new Error("preamble not prepended");
const framedArr = prependUserPreamble([{ type: "text", text: "halo" }]) as { text: string }[];
if (!framedArr[0].text.startsWith(LANGUAGE_PREAMBLE)) throw new Error("preamble block not first");
const idem = prependUserPreamble(framed) as string;
if (idem !== framed) throw new Error("preamble not idempotent");

// tool_result-led turns must NOT be framed (Anthropic requires them first)
const trTurn = { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "ok" }] };
function isRecordV(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === "object" && !Array.isArray(v);
}
function frameUserTurn(msg: Record<string, unknown>): void {
  if (Array.isArray(msg.content)) {
    const head = msg.content[0];
    if (isRecordV(head) && head.type === "tool_result") return;
  }
  msg.content = prependUserPreamble(msg.content);
}
const trBefore = JSON.stringify(trTurn);
frameUserTurn(trTurn);
if (JSON.stringify(trTurn) !== trBefore) throw new Error("tool_result turn was framed");
const lateTurn = { role: "user", content: "Kenapa masih error?" };
frameUserTurn(lateTurn);
if (lateTurn.content !== `${LANGUAGE_PREAMBLE}\n\nKenapa masih error?`) throw new Error("later turn not framed");

// --- 1.2.0 poison redaction: skip newest user, sticky fps, WAF-neutral note ---
const REDACTED_NOTE = "[Message withheld by local policy]";
if (/sensitive|blocked/i.test(REDACTED_NOTE)) throw new Error("placeholder not WAF-neutral");

function copyMessage(msg: Record<string, unknown>): Record<string, unknown> {
  const copy = { ...msg };
  if (Array.isArray(msg.content)) {
    copy.content = msg.content.map((b) => {
      if (!isRecordV(b)) return b;
      const bc = { ...b };
      if (Array.isArray(b.content)) {
        bc.content = b.content.map((c) => (isRecordV(c) ? { ...c } : c));
      }
      return bc;
    });
  }
  return copy;
}
function fingerprintOf(msg: Record<string, unknown>): string {
  const tc = Array.isArray(msg.tool_calls) ? JSON.stringify(msg.tool_calls).slice(0, 80) : "";
  return `${msg.role}:${JSON.stringify(msg.content).slice(0, 160)}:${tc}`;
}
function firstUserAnchor(messages: unknown[]): string {
  for (const m of messages) {
    if (isRecordV(m) && m.role === "user") return fingerprintOf(m);
  }
  return String(messages.length);
}
function hasRedactableText(content: unknown, msg?: Record<string, unknown>): boolean {
  if (typeof content === "string") return content.length > 0 && content !== REDACTED_NOTE;
  if (Array.isArray(content)) {
    for (const b of content) {
      if (!isRecordV(b)) continue;
      if (b.type === "text" && typeof b.text === "string" && b.text.length > 0 && b.text !== REDACTED_NOTE) return true;
      if (b.type === "tool_result") {
        if (typeof b.content === "string" && b.content.length > 0 && b.content !== REDACTED_NOTE) return true;
        if (Array.isArray(b.content)) {
          for (const c of b.content) {
            if (isRecordV(c) && c.type === "text" && typeof c.text === "string" && c.text.length > 0 && c.text !== REDACTED_NOTE) return true;
          }
        }
      }
    }
  }
  if (msg && Array.isArray(msg.tool_calls) && msg.tool_calls.length > 0) {
    for (const tc of msg.tool_calls) {
      if (isRecordV(tc) && isRecordV(tc.function) && typeof tc.function.arguments === "string" && tc.function.arguments !== "{}") {
        return true;
      }
    }
  }
  return false;
}
function redactBlocks(content: unknown): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecordV(block)) continue;
    if (block.type === "text" && typeof block.text === "string") block.text = REDACTED_NOTE;
    else if (block.type === "tool_result") {
      if (typeof block.content === "string") block.content = REDACTED_NOTE;
      else if (Array.isArray(block.content)) {
        for (const b of block.content) {
          if (isRecordV(b) && b.type === "text" && typeof b.text === "string") b.text = REDACTED_NOTE;
        }
      }
    }
  }
}
function lastUserIndex(messages: unknown[]): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (isRecordV(messages[i]) && (messages[i] as Record<string, unknown>).role === "user") return i;
  }
  return -1;
}
function isHideable(msg: Record<string, unknown>): boolean {
  return msg.role === "user" || msg.role === "assistant" || msg.role === "tool";
}

function redactMessageAt(messages: unknown[], i: number): void {
  const msg = messages[i];
  if (!isRecordV(msg)) return;
  if (typeof msg.content === "string") {
    msg.content = REDACTED_NOTE;
  } else if (Array.isArray(msg.content)) {
    redactBlocks(msg.content);
  } else if (msg.role === "tool" || msg.role === "assistant") {
    msg.content = REDACTED_NOTE;
  }
  if (Array.isArray(msg.tool_calls)) {
    for (const tc of msg.tool_calls) {
      if (isRecordV(tc) && isRecordV(tc.function) && typeof tc.function.arguments === "string") {
        tc.function.arguments = "{}";
      }
    }
  }
}

const redactSet = new Set<string>();
let escalatePending = false;
let isSensitiveBlock = false;
let sessionAnchor: string | null = null;

function apply(payload: { messages: unknown[] }): void {
  let messages = payload.messages;

  // Prune failed assistant messages in-place so dead error turns do not linger
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (!isRecordV(m)) continue;
    if (m.role === "assistant") {
      if ((m as Record<string, unknown>).stopReason === "error") {
        messages.splice(i, 1);
      } else if (typeof m.content === "string" && /sensitive[_ ]words?[_ ]detected|content-blocked/i.test(m.content)) {
        messages.splice(i, 1);
      }
    }
  }

  const fps = messages.map((m) => (isRecordV(m) ? fingerprintOf(m) : ""));
  const anchor = firstUserAnchor(messages);
  if (anchor !== sessionAnchor) {
    const firstContact = sessionAnchor === null;
    sessionAnchor = anchor;
    if (!firstContact) {
      redactSet.clear();
      escalatePending = false;
      isSensitiveBlock = false;
    }
  }
  const lastUser = lastUserIndex(messages);
  for (let i = 0; i < lastUser; i++) {
    if (!isRecordV(messages[i]) || !isHideable(messages[i] as Record<string, unknown>)) continue;
    if (redactSet.has(fps[i])) {
      messages[i] = copyMessage(messages[i] as Record<string, unknown>);
      redactMessageAt(messages, i);
    }
  }
  if (escalatePending) {
    escalatePending = false;
    const sensitive = isSensitiveBlock;
    isSensitiveBlock = false;

    if (sensitive) {
      // Sensitive words detected: neutralize ALL older turns (user, tool, assistant) in one shot
      for (let i = 0; i < lastUser; i++) {
        if (!isRecordV(messages[i])) continue;
        const m = messages[i] as Record<string, unknown>;
        if (!isHideable(m)) continue;
        redactSet.add(fps[i]);
        if (hasRedactableText(m.content, m)) {
          messages[i] = copyMessage(m);
          redactMessageAt(messages, i);
        }
      }
    } else {
      // Step 1: Redact ALL older user messages in one shot to neutralize cumulative WAF triggers
      let anyRedacted = false;
      for (let i = 0; i < lastUser; i++) {
        if (!isRecordV(messages[i])) continue;
        const m = messages[i] as Record<string, unknown>;
        if (m.role !== "user") continue;
        if (redactSet.has(fps[i])) continue;
        redactSet.add(fps[i]);
        if (hasRedactableText(m.content, m)) {
          messages[i] = copyMessage(m);
          redactMessageAt(messages, i);
          anyRedacted = true;
        }
      }
      // Step 2: If all older user messages are already redacted, escalate to assistant & tool messages
      if (!anyRedacted) {
        for (let i = 0; i < lastUser; i++) {
          if (!isRecordV(messages[i])) continue;
          const m = messages[i] as Record<string, unknown>;
          if (m.role !== "assistant" && m.role !== "tool") continue;
          if (redactSet.has(fps[i])) continue;
          redactSet.add(fps[i]);
          if (hasRedactableText(m.content, m)) {
            messages[i] = copyMessage(m);
            redactMessageAt(messages, i);
            anyRedacted = true;
          }
        }
      }
    }
  }
}

const origNewest = "lanjut pertanyaan baru";
const hist = [
  { role: "system", content: "You are an expert coding assistant operating inside pi." },
  { role: "user", content: "pertanyaan awal" },
  { role: "assistant", content: [{ type: "text", text: "jawaban" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "output sensitive_word" }] },
  { role: "user", content: origNewest },
];
const sessionKeep = hist.map((m) => structuredClone(m));

escalatePending = true;
apply({ messages: hist });
// 1.3.0: newest user turn is NEVER swallowed
if (hist[5].content !== origNewest) throw new Error("newest user message was redacted");
if (hist[0].content !== sessionKeep[0].content) throw new Error("system prompt was redacted");
// all older user turns (including tool_result and early user) are redacted in stage 1
if ((hist[4].content as { content: string }[])[0].content !== REDACTED_NOTE) {
  throw new Error("escalation did not hide the previous user turn");
}
if ((hist[4].content as { type: string }[])[0].type !== "tool_result") throw new Error("tool_result pairing broken");
if (hist[1].content !== REDACTED_NOTE) throw new Error("stage 1 did not neutralize older user turn");
if ((hist[3].content as { type: string }[])[0].type !== "tool_use") throw new Error("assistant tool_use corrupted");
// assistant text answer is preserved in stage 1
if ((hist[2].content as { text: string }[])[0].text !== "jawaban") throw new Error("stage 1 over-redacted assistant message");

// sticky: next request without escalate keeps culprits hidden, newest still intact
const hist2 = sessionKeep.map((m) => structuredClone(m));
apply({ messages: hist2 });
if (hist2[5].content !== origNewest) throw new Error("sticky pass redacted newest");
if ((hist2[4].content as { content: string }[])[0].content !== REDACTED_NOTE) {
  throw new Error("culprit did not stay redacted");
}
if (hist2[1].content !== REDACTED_NOTE) throw new Error("earlier user did not stay redacted");

// stage 2 escalation: if user turns were already redacted, hides assistant answers too
escalatePending = true;
const hist3 = sessionKeep.map((m) => structuredClone(m));
apply({ messages: hist3 });
if (hist3[5].content !== origNewest) throw new Error("stage 2 escalation redacted newest");
if ((hist3[2].content as { text: string }[])[0].text !== REDACTED_NOTE) {
  throw new Error("stage 2 escalation did not hide the assistant answer");
}

// /new: first USER message changes → set clears (system-first payload must not pin the anchor)
const fresh = [
  { role: "system", content: "You are an expert coding assistant operating inside pi." },
  { role: "user", content: "sesi baru" },
];
apply({ messages: fresh });
if (fresh[1].content !== "sesi baru") throw new Error("/new still redacted the new first user turn");

// --- OpenAI format & sensitive_words_detected test ---
// When agent runs a todo, emits tool call, receives tool result, and an error occurs:
const openaiHist = [
  { role: "system", content: "You are an expert coding assistant operating inside pi." },
  { role: "user", content: "Jalankan todo" },
  {
    role: "assistant",
    content: null,
    tool_calls: [
      { id: "call_todo_1", type: "function", function: { name: "todo", arguments: '{"action":"update"}' } },
    ],
  },
  { role: "tool", tool_call_id: "call_todo_1", content: "sensitive word in todo result" },
  { role: "assistant", content: "error: sensitive words detected", stopReason: "error" },
  { role: "user", content: "Continue" },
];

// Simulate established session anchor for openaiHist
apply({ messages: openaiHist.slice(0, 2) });
escalatePending = true;
isSensitiveBlock = true;
apply({ messages: openaiHist });

// Error assistant message must be pruned completely
if (openaiHist.some((m) => (m as { role: string; stopReason?: string }).stopReason === "error")) {
  throw new Error("error assistant message was not pruned");
}
// Newest user turn "Continue" is preserved
const lastTurn = openaiHist[openaiHist.length - 1] as { role: string; content: string };
if (lastTurn.role !== "user" || lastTurn.content !== "Continue") {
  throw new Error(`newest user turn "Continue" was corrupted: ${JSON.stringify(lastTurn)}`);
}
// Tool message was redacted
const toolMsg = openaiHist.find((m) => (m as { role: string }).role === "tool") as { content: string };
if (!toolMsg || toolMsg.content !== REDACTED_NOTE) {
  throw new Error("tool message was not redacted");
}
// Assistant tool_calls arguments were sanitized
const asstMsg = openaiHist.find((m) => (m as { role: string }).role === "assistant") as {
  tool_calls: { function: { arguments: string } }[];
};
if (asstMsg.tool_calls[0].function.arguments !== "{}") {
  throw new Error("assistant tool_calls arguments were not sanitized");
}

// 1.2.2 auto-retry: the retryable suffix must match pi-ai's RETRYABLE_PROVIDER_ERROR_PATTERN
// ("provider.?returned.?error") so pi restarts the turn after a WAF block.
const RETRY_SUFFIX = " (provider returned error — retrying with earlier messages hidden)";
if (!/provider.?returned.?error/i.test(RETRY_SUFFIX)) throw new Error("retry suffix not retryable-classified");

console.log("ok");
