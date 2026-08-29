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

// --- poison redaction self-check ---
const REDACTED_NOTE =
  "[Message redacted automatically: AgentRouter's content filter blocked it as containing sensitive words.]";
function redactBlocks(content: unknown): void {
  if (!Array.isArray(content)) return;
  for (const block of content) {
    if (!isRecordV(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      block.text = REDACTED_NOTE;
    } else if (block.type === "tool_result") {
      if (typeof block.content === "string") block.content = REDACTED_NOTE;
      else if (Array.isArray(block.content)) {
        for (const b of block.content) {
          if (isRecordV(b) && b.type === "text" && typeof b.text === "string") b.text = REDACTED_NOTE;
        }
      }
    }
  }
}
function redactFromEnd(messages: Record<string, unknown>[], depth: number): void {
  let remaining = depth;
  for (let i = messages.length - 1; i >= 0 && remaining > 0; i--) {
    const msg = messages[i];
    if (msg.role !== "user") continue;
    if (typeof msg.content === "string") msg.content = REDACTED_NOTE;
    else redactBlocks(msg.content);
    remaining--;
  }
}

const hist = [
  { role: "user", content: "pertanyaan awal" },
  { role: "assistant", content: [{ type: "text", text: "jawaban" }] },
  { role: "assistant", content: [{ type: "tool_use", id: "t1", name: "bash", input: {} }] },
  { role: "user", content: [{ type: "tool_result", tool_use_id: "t1", content: "output sensitive_word" }] },
  { role: "user", content: "lanjut dengan sensitive_word" },
];
redactFromEnd(hist, 1);
if (hist[4].content !== REDACTED_NOTE) throw new Error("poison message not redacted");
if (hist[3].content[0].content !== "output sensitive_word") throw new Error("tool_result redacted too early");
if (hist[0].content !== "pertanyaan awal") throw new Error("innocent early message was redacted");
if (hist[2].content[0].type !== "tool_use") throw new Error("assistant tool_use corrupted");

// depth escalation reaches the earlier tool_result message on the next failure
redactFromEnd(hist, 2);
if (hist[3].content[0].type !== "tool_result" || hist[3].content[0].content !== REDACTED_NOTE) {
  throw new Error("escalation did not redact tool_result / pairing broken");
}
if (hist[0].content !== "pertanyaan awal") throw new Error("escalation over-redacted");

console.log("ok");
