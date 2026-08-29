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
  "[Instruction: Process the user request below and respond in the appropriate language.]";
function prependUserPreamble(content: unknown): unknown {
  if (typeof content === "string") {
    if (content.startsWith(LANGUAGE_PREAMBLE)) return content;
    return content ? `${LANGUAGE_PREAMBLE}\n\n${content}` : LANGUAGE_PREAMBLE;
  }
  if (!Array.isArray(content)) return content;
  const head = content[0] as { type?: string; text?: string };
  if (head?.type === "text" && head.text === LANGUAGE_PREAMBLE) return content;
  content.unshift({ type: "text", text: LANGUAGE_PREAMBLE });
  return content;
}
const framed = prependUserPreamble("Tolong bantu saya perbaiki bug ini") as string;
if (!framed.startsWith(LANGUAGE_PREAMBLE)) throw new Error("preamble not prepended");
const framedArr = prependUserPreamble([{ type: "text", text: "halo" }]) as { text: string }[];
if (framedArr[0].text !== LANGUAGE_PREAMBLE) throw new Error("preamble block not first");
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
  return `${msg.role}:${JSON.stringify(msg.content).slice(0, 160)}`;
}
function firstUserAnchor(messages: unknown[]): string {
  for (const m of messages) {
    if (isRecordV(m) && m.role === "user") return fingerprintOf(m);
  }
  return String(messages.length);
}
function hasRedactableText(content: unknown): boolean {
  if (typeof content === "string") return content.length > 0;
  if (!Array.isArray(content)) return false;
  for (const b of content) {
    if (!isRecordV(b)) continue;
    if (b.type === "text" && typeof b.text === "string" && b.text.length > 0) return true;
    if (b.type === "tool_result") {
      if (typeof b.content === "string" && b.content.length > 0) return true;
      if (Array.isArray(b.content)) {
        for (const c of b.content) {
          if (isRecordV(c) && c.type === "text" && typeof c.text === "string" && c.text.length > 0) return true;
        }
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
  return msg.role === "user" || msg.role === "assistant";
}

const redactSet = new Set<string>();
let escalatePending = false;
let sessionAnchor: string | null = null;
let escalateBatch = 1;

function apply(payload: { messages: unknown[] }): void {
  const messages = payload.messages;
  const fps = messages.map((m) => (isRecordV(m) ? fingerprintOf(m) : ""));
  const anchor = firstUserAnchor(messages);
  if (anchor !== sessionAnchor) {
    const firstContact = sessionAnchor === null;
    sessionAnchor = anchor;
    if (!firstContact) {
      redactSet.clear();
      escalatePending = false;
      escalateBatch = 1;
    }
  }
  const lastUser = lastUserIndex(messages);
  for (let i = 0; i < lastUser; i++) {
    if (!isRecordV(messages[i]) || !isHideable(messages[i] as Record<string, unknown>)) continue;
    if (redactSet.has(fps[i])) {
      messages[i] = copyMessage(messages[i] as Record<string, unknown>);
      const copy = messages[i] as Record<string, unknown>;
      if (typeof copy.content === "string") copy.content = REDACTED_NOTE;
      else redactBlocks(copy.content);
    }
  }
  if (escalatePending) {
    escalatePending = false;
    let budget = escalateBatch;
    escalateBatch = Math.min(escalateBatch * 2, 60);
    for (let i = lastUser - 1; i >= 0 && redactSet.size < 60 && budget > 0; i--) {
      if (!isRecordV(messages[i]) || !isHideable(messages[i] as Record<string, unknown>)) continue;
      if (redactSet.has(fps[i])) continue;
      redactSet.add(fps[i]);
      if (!hasRedactableText((messages[i] as Record<string, unknown>).content)) continue;
      messages[i] = copyMessage(messages[i] as Record<string, unknown>);
      const copy = messages[i] as Record<string, unknown>;
      if (typeof copy.content === "string") copy.content = REDACTED_NOTE;
      else redactBlocks(copy.content);
      budget--;
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
// 1.2.0: newest user turn is NEVER swallowed (1.0.7 Bug A)
if (hist[5].content !== origNewest) throw new Error("newest user message was redacted");
if (hist[0].content !== sessionKeep[0].content) throw new Error("system prompt was redacted");
// first hideable older message from the end = tool_result user turn
if ((hist[4].content as { content: string }[])[0].content !== REDACTED_NOTE) {
  throw new Error("escalation did not hide the previous user turn");
}
if ((hist[4].content as { type: string }[])[0].type !== "tool_result") throw new Error("tool_result pairing broken");
if (hist[1].content !== "pertanyaan awal") throw new Error("innocent early user was redacted on first escalate");
if ((hist[3].content as { type: string }[])[0].type !== "tool_use") throw new Error("assistant tool_use corrupted");

// sticky: next request without escalate keeps the culprit hidden, newest still intact
const hist2 = sessionKeep.map((m) => structuredClone(m));
apply({ messages: hist2 });
if (hist2[5].content !== origNewest) throw new Error("sticky pass redacted newest");
if ((hist2[4].content as { content: string }[])[0].content !== REDACTED_NOTE) {
  throw new Error("culprit did not stay redacted");
}

// exponential escalation: second WAF block hides 2 more (assistant answer + earliest user)
escalatePending = true;
const hist3 = sessionKeep.map((m) => structuredClone(m));
apply({ messages: hist3 });
if (hist3[5].content !== origNewest) throw new Error("2nd escalation redacted newest");
if ((hist3[2].content as { text: string }[])[0].text !== REDACTED_NOTE) {
  throw new Error("2nd escalation did not hide the assistant answer");
}
if (hist3[1].content !== REDACTED_NOTE) throw new Error("2nd escalation did not hide the earliest user");

// /new: first USER message changes → set clears (system-first payload must not pin the anchor)
const fresh = [
  { role: "system", content: "You are an expert coding assistant operating inside pi." },
  { role: "user", content: "sesi baru" },
];
apply({ messages: fresh });
if (fresh[1].content !== "sesi baru") throw new Error("/new still redacted the new first user turn");

// 1.2.2 auto-retry: the retryable suffix must match pi-ai's RETRYABLE_PROVIDER_ERROR_PATTERN
// ("provider.?returned.?error") so pi restarts the turn after a WAF block.
const RETRY_SUFFIX = " (provider returned error — retrying with earlier messages hidden)";
if (!/provider.?returned.?error/i.test(RETRY_SUFFIX)) throw new Error("retry suffix not retryable-classified");

console.log("ok");
