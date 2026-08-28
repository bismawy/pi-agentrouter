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

console.log("ok");
