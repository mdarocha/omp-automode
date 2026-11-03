import { CHARS_PER_APPROX_TOKEN } from "./constants.ts";
import { truncateMiddle } from "./utils.ts";

/** Prefix of every transcript line that carries tool output. The classifier prompt names it. */
export const TOOL_RESULT_LABEL = "UntrustedToolResult";

const CALL_SUMMARY_CHARS = 200;
// Test and build output ends with the verdict, so the tail gets the larger share.
const HEAD_FRACTION = 0.4;
const OMITTED_MARKER = "\n[… output omitted …]\n";

export type ToolResultInput = {
  toolName: string;
  /** Short description of the call that produced the result; empty when unknown. */
  call: string;
  isError: boolean;
  exitCode?: number;
  /** A message `content` value: a string or an array of content blocks. */
  content: unknown;
};

export type RenderedToolResult = { text: string; truncated: boolean };

function compactJson(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "";
  } catch {
    return "";
  }
}

/** Describe a tool call's input in one bounded line, preferring a bash command. */
export function summarizeToolCall(input: unknown): string {
  const command = typeof input === "object" && input !== null && "command" in input
    ? input.command
    : undefined;
  return truncateMiddle(
    typeof command === "string" ? command : compactJson(input),
    CALL_SUMMARY_CHARS,
  );
}

export function exitCodeFromDetails(details: unknown): number | undefined {
  if (typeof details !== "object" || details === null || !("exitCode" in details)) {
    return undefined;
  }
  return typeof details.exitCode === "number" && Number.isInteger(details.exitCode)
    ? details.exitCode
    : undefined;
}

/** Text blocks of a message `content` value. Images and other blocks carry no excerptable text. */
export function textBlocks(content: unknown): string[] {
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  const blocks: string[] = [];
  for (const block of content) {
    if (
      typeof block === "object" && block !== null && "type" in block &&
      block.type === "text" && "text" in block && typeof block.text === "string"
    ) {
      blocks.push(block.text);
    }
  }
  return blocks;
}

function prefix(blocks: string[], limit: number): string {
  let text = "";
  for (const block of blocks) {
    if (text.length >= limit) break;
    text += (text.length > 0 ? "\n" : "") + block.slice(0, limit);
  }
  return text.slice(0, limit);
}

function suffix(blocks: string[], limit: number): string {
  let text = "";
  for (let index = blocks.length - 1; index >= 0; index -= 1) {
    if (text.length >= limit) break;
    text = blocks[index].slice(-limit) + (text.length > 0 ? "\n" : "") + text;
  }
  return text.slice(-limit);
}

/** Keep the start and end of the output without joining the whole of a large result. */
function excerpt(blocks: string[], limit: number): { text: string; omittedChars: number } {
  const total = blocks.reduce((sum, block) => sum + block.length, 0) +
    Math.max(0, blocks.length - 1);
  if (total <= limit) return { text: blocks.join("\n"), omittedChars: 0 };
  if (limit <= OMITTED_MARKER.length) return { text: "", omittedChars: total };
  const available = limit - OMITTED_MARKER.length;
  const headChars = Math.ceil(available * HEAD_FRACTION);
  const head = prefix(blocks, headChars);
  const tail = suffix(blocks, available - headChars);
  return {
    text: head + OMITTED_MARKER + tail,
    omittedChars: Math.max(1, total - head.length - tail.length),
  };
}

function envelope(
  input: ToolResultInput,
  shown: { text: string; omittedChars: number },
): string {
  const json = JSON.stringify({
    tool: input.toolName,
    ...(input.call ? { call: input.call } : {}),
    isError: input.isError,
    ...(input.exitCode === undefined ? {} : { exitCode: input.exitCode }),
    truncated: shown.omittedChars > 0,
    ...(shown.omittedChars > 0 ? { omittedChars: shown.omittedChars } : {}),
    excerpt: shown.text,
  });
  // `\u003c` decodes to `<` but keeps result text from closing the
  // `<classifier-transcript>` block it is embedded in or opening a forged one.
  return `${TOOL_RESULT_LABEL} ${json.replaceAll("<", "\\u003c")}`;
}

/**
 * Render one tool result as a single JSON line within `maxTokens`. The JSON
 * encoding keeps result text from posing as another transcript line. Returns
 * undefined when not even an empty excerpt fits.
 */
export function renderToolResult(
  input: ToolResultInput,
  maxTokens: number,
): RenderedToolResult | undefined {
  const maxChars = maxTokens * CHARS_PER_APPROX_TOKEN;
  const blocks = textBlocks(input.content);
  let limit = maxChars - envelope(input, { text: "", omittedChars: 0 }).length;
  while (limit >= 0) {
    const shown = excerpt(blocks, limit);
    const text = envelope(input, shown);
    if (text.length <= maxChars) return { text, truncated: shown.omittedChars > 0 };
    // JSON escaping can inflate the excerpt; shrink in proportion until it fits.
    limit = Math.min(limit - 1, Math.floor(limit * (maxChars / text.length) * 0.95));
  }
  return undefined;
}
