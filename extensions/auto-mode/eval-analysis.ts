/**
 * Best-effort static analysis of OMP `eval` tool input.
 *
 * `eval` runs Python or JavaScript cells. Shell commands can hide inside that
 * code (`subprocess.run`, `os.system`, `child_process.exec`, Bun's `$`, IPython
 * `!cmd`), so permission rules and hard-deny checks written for `bash` never
 * see them. This module tokenizes the code, extracts the shell commands whose
 * text is a literal, and reports everything it cannot extract as *opaque*.
 *
 * It is a lexical scanner, not an interpreter and not a sandbox. It cannot see
 * values computed at run time, aliases bound by an earlier eval call (the
 * Python and JavaScript sessions persist between calls), or code reached
 * through files. Whenever the scanner is unsure it must prefer an opaque
 * verdict over a missed command. Opaque evals are never fast-allowed.
 *
 * `tool.bash(...)` and other `tool.*` calls made from eval code do not need
 * parsing here: OMP routes them through the `tool_call` hook under the
 * canonical tool name.
 */

export type EvalLanguage = "py" | "js";

/** A shell command recovered from literal eval code. */
export type EvalEmbeddedCommand = {
  command: string;
  /** Human-readable source such as `subprocess.run` or `Bun.$`. */
  origin: string;
};

export type EvalAnalysis = {
  /** The code of every cell, for matching `eval(...)` permission patterns. */
  codeTexts: string[];
  /** Language declared by the call, when recognised. */
  language?: EvalLanguage;
  commands: EvalEmbeddedCommand[];
  /** Why the eval cannot be fully understood statically. Empty means fully extracted. */
  opaqueReasons: string[];
};

export const MAX_EVAL_ANALYSIS_LENGTH = 512 * 1024;
const MAX_EMBEDDED_COMMANDS = 100;
const MAX_OPAQUE_REASONS = 20;

const PYTHON_LANGUAGE_NAMES = new Set(["py", "python"]);
const JAVASCRIPT_LANGUAGE_NAMES = new Set(["js", "javascript"]);

/** Map an `eval` language token (`py`, `python`, `js`, `javascript`) to its canonical form. */
export function normalizeEvalLanguage(value: unknown): EvalLanguage | undefined {
  if (typeof value !== "string") return undefined;
  const name = value.trim().toLowerCase();
  if (PYTHON_LANGUAGE_NAMES.has(name)) return "py";
  if (JAVASCRIPT_LANGUAGE_NAMES.has(name)) return "js";
  return undefined;
}

type EvalCell = { code: string; language: EvalLanguage | undefined; languageGiven: boolean };

function evalCells(input: Record<string, unknown>): { cells: EvalCell[]; problems: string[] } {
  const cells: EvalCell[] = [];
  const problems: string[] = [];
  const addCell = (code: unknown, language: unknown) => {
    if (typeof code !== "string") {
      problems.push("eval cell has no string code");
      return;
    }
    cells.push({
      code,
      language: normalizeEvalLanguage(language),
      languageGiven: language !== undefined && language !== null,
    });
  };
  if (input.code !== undefined) addCell(input.code, input.language);
  if (Array.isArray(input.cells)) {
    for (const cell of input.cells as unknown[]) {
      if (typeof cell !== "object" || cell === null) {
        problems.push("eval cell is not an object");
        continue;
      }
      const record = cell as Record<string, unknown>;
      addCell(record.code, record.language ?? input.language);
    }
  } else if (input.cells !== undefined) {
    problems.push("eval cells is not an array");
  }
  if (cells.length === 0 && problems.length === 0) problems.push("eval input has no recognizable code");
  return { cells, problems };
}

/** The code text of every cell in an eval call, used to match `eval(...)` patterns. */
export function evalCodeTexts(input: Record<string, unknown>): string[] {
  return evalCells(input).cells.map((cell) => cell.code);
}

/** The declared language of an eval call, when it is a recognised token. */
export function evalInputLanguage(input: Record<string, unknown>): EvalLanguage | undefined {
  return normalizeEvalLanguage(input.language);
}

const EVAL_PATTERN_SCOPE = /^(py|python|js|javascript):[ \t]?([\s\S]*)$/i;

/**
 * Split an `eval(...)` permission argument into an optional language scope and
 * the wildcard pattern for the code text. `eval(py: subprocess*)` only applies
 * to Python cells; anything else is matched against every language.
 */
export function parseEvalPattern(argumentPattern: string): { language?: EvalLanguage; codePattern: string } {
  const scoped = EVAL_PATTERN_SCOPE.exec(argumentPattern);
  if (!scoped) return { codePattern: argumentPattern };
  return { language: normalizeEvalLanguage(scoped[1]), codePattern: scoped[2] ?? "" };
}

// ---------------------------------------------------------------------------
// Shell rendering
// ---------------------------------------------------------------------------

// Glob characters and a leading `~` stay unquoted. Argv-form commands never
// expand them, but rendering them live makes the analyzer treat them as
// expanding, which can only make deny rules and hard-deny checks stricter.
const SHELL_SAFE_WORD = /^(?:~|~?[A-Za-z0-9_@%+:,./^*?[\]-]+)$/;
const SHELL_SAFE_COMMAND_NAME = /^(?:~|~?[A-Za-z0-9_@%+:,./^-]+)$/;

/** Quote one argv element for a shell command line. */
export function shellQuoteWord(word: string, commandName = false): string {
  if (word !== "" && (commandName ? SHELL_SAFE_COMMAND_NAME : SHELL_SAFE_WORD).test(word)) return word;
  return `'${word.replace(/'/g, `'\\''`)}'`;
}

function renderArgv(argv: string[]): string {
  return argv.map((word, index) => shellQuoteWord(word, index === 0)).join(" ");
}

function withWorkingDirectory(command: string, cwd: string | undefined): string {
  return cwd === undefined ? command : `cd ${shellQuoteWord(cwd)} && ${command}`;
}

// ---------------------------------------------------------------------------
// Tokens
// ---------------------------------------------------------------------------

type TokenKind =
  | "ident"
  | "string"
  | "number"
  | "punct"
  | "tpl-start"
  | "tpl-end"
  | "shell"
  | "magic"
  | "cell-magic";

type Token = {
  kind: TokenKind;
  /** Identifier name, punctuation, shell command, or magic name. */
  text: string;
  /** Cooked string value, magic arguments, or cell-magic body. */
  value?: string;
  /** Raw template text, used for Bun shell templates. */
  raw?: string;
  /** String with interpolation or an escape the scanner cannot cook. */
  dynamic?: boolean;
  template?: boolean;
  line: number;
};

class LexError extends Error {}

type Collector = { commands: EvalEmbeddedCommand[]; opaque: string[] };

function addOpaque(collector: Collector, reason: string): void {
  if (collector.opaque.length >= MAX_OPAQUE_REASONS || collector.opaque.includes(reason)) return;
  collector.opaque.push(reason);
}

function addCommand(collector: Collector, command: string, origin: string): void {
  if (collector.commands.length >= MAX_EMBEDDED_COMMANDS) {
    addOpaque(collector, `more than ${MAX_EMBEDDED_COMMANDS} embedded shell commands`);
    return;
  }
  collector.commands.push({ command, origin });
}

function isPunct(token: Token | undefined, text: string): boolean {
  return token?.kind === "punct" && token.text === text;
}

function isIdent(token: Token | undefined, text?: string): boolean {
  return token?.kind === "ident" && (text === undefined || token.text === text);
}

function normalizeNewlines(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

const IDENT_START = /[\p{ID_Start}_]/uy;
const IDENT_PART = /[\p{ID_Continue}]/uy;
const JS_IDENT_START = /[\p{ID_Start}$_]/uy;
const JS_IDENT_PART = /[\p{ID_Continue}$\u200c\u200d]/uy;

function matchesAt(pattern: RegExp, source: string, index: number): boolean {
  pattern.lastIndex = index;
  return pattern.test(source);
}

function readIdentifier(source: string, start: number, startPattern: RegExp, partPattern: RegExp): number {
  let end = start;
  if (!matchesAt(startPattern, source, end)) return start;
  end += source.codePointAt(end)! > 0xffff ? 2 : 1;
  while (end < source.length && matchesAt(partPattern, source, end)) {
    end += source.codePointAt(end)! > 0xffff ? 2 : 1;
  }
  return end;
}

const HEX = /^[0-9a-fA-F]+$/;

function hexEscape(source: string, index: number, length: number): string | undefined {
  const digits = source.slice(index, index + length);
  if (digits.length !== length || !HEX.test(digits)) return undefined;
  return String.fromCodePoint(Number.parseInt(digits, 16));
}

const SIMPLE_ESCAPES: Record<string, string> = {
  n: "\n",
  r: "\r",
  t: "\t",
  b: "\b",
  f: "\f",
  v: "\v",
};

/** Decode one JavaScript escape at `index` (just after the backslash). */
function cookJsEscape(source: string, index: number): { text: string; next: number } {
  const ch = source[index] ?? "";
  if (ch === "\n") return { text: "", next: index + 1 };
  const simple = SIMPLE_ESCAPES[ch];
  if (simple !== undefined) return { text: simple, next: index + 1 };
  if (ch === "0" && !/[0-9]/.test(source[index + 1] ?? "")) return { text: "\0", next: index + 1 };
  if (ch === "x") {
    const text = hexEscape(source, index + 1, 2);
    if (text !== undefined) return { text, next: index + 3 };
  }
  if (ch === "u") {
    if (source[index + 1] === "{") {
      const close = source.indexOf("}", index + 2);
      const digits = close < 0 ? "" : source.slice(index + 2, close);
      if (HEX.test(digits) && Number.parseInt(digits, 16) <= 0x10ffff) {
        return { text: String.fromCodePoint(Number.parseInt(digits, 16)), next: close + 1 };
      }
    } else {
      const text = hexEscape(source, index + 1, 4);
      if (text !== undefined) return { text, next: index + 5 };
    }
  }
  return { text: ch, next: index + 1 };
}

/** Decode one Python escape at `index` (just after the backslash). */
function cookPythonEscape(source: string, index: number): { text: string; next: number; unknown?: boolean } {
  const ch = source[index] ?? "";
  if (ch === "\n") return { text: "", next: index + 1 };
  if (ch === "\\" || ch === "'" || ch === '"') return { text: ch, next: index + 1 };
  if (ch === "a") return { text: "\x07", next: index + 1 };
  const simple = SIMPLE_ESCAPES[ch];
  if (simple !== undefined) return { text: simple, next: index + 1 };
  if (/[0-7]/.test(ch)) {
    let digits = ch;
    while (digits.length < 3 && /[0-7]/.test(source[index + digits.length] ?? "")) {
      digits += source[index + digits.length];
    }
    return { text: String.fromCodePoint(Number.parseInt(digits, 8)), next: index + digits.length };
  }
  const widths: Record<string, number> = { x: 2, u: 4, U: 8 };
  const width = widths[ch];
  if (width !== undefined) {
    const text = hexEscape(source, index + 1, width);
    if (text !== undefined) return { text, next: index + 1 + width };
    return { text: "", next: index + 1, unknown: true };
  }
  if (ch === "N") return { text: "", next: index + 1, unknown: true };
  return { text: `\\${ch}`, next: index + 1 };
}

const PYTHON_STRING_PREFIXES = new Set(["r", "u", "b", "f", "br", "rb", "fr", "rf"]);
const PYTHON_STRING_PREFIX = /[A-Za-z]{1,2}(?=['"])/y;
const PYTHON_TWO_CHAR_PUNCT = new Set(["==", "!=", "<=", ">=", ":="]);

/** Read the remainder of a line, folding backslash continuations like OMP's runner does. */
function readFoldedLine(source: string, start: number): { text: string; end: number; newlines: number } {
  let text = "";
  let index = start;
  let newlines = 0;
  while (index < source.length) {
    const ch = source[index]!;
    if (ch === "\\" && source[index + 1] === "\n") {
      index += 2;
      newlines += 1;
      continue;
    }
    if (ch === "\n") break;
    text += ch;
    index += 1;
  }
  return { text, end: index, newlines };
}

/** Expressions inside the braces of an f-string body, or undefined when the braces are malformed. */
function fstringExpressions(body: string): string[] | undefined {
  const expressions: string[] = [];
  let index = 0;
  while (index < body.length) {
    if (body[index] !== "{") {
      index += 1;
      continue;
    }
    if (body[index + 1] === "{") {
      index += 2;
      continue;
    }
    let depth = 1;
    let cursor = index + 1;
    while (cursor < body.length && depth > 0) {
      const ch = body[cursor]!;
      if (ch === "'" || ch === '"') {
        const end = body.indexOf(ch, cursor + 1);
        if (end < 0) return undefined;
        cursor = end + 1;
        continue;
      }
      if (ch === "{" || ch === "[" || ch === "(") depth += 1;
      else if (ch === "}" || ch === "]" || ch === ")") depth -= 1;
      cursor += 1;
    }
    if (depth !== 0) return undefined;
    expressions.push(body.slice(index + 1, cursor - 1));
    index = cursor;
  }
  return expressions;
}

/**
 * Tokenize Python source. Pushes into `out` as it goes so tokens before a
 * lexical error stay available to the extractor.
 */
function lexPython(input: string, out: Token[], inFString = false): void {
  const source = normalizeNewlines(input);
  let index = 0;
  let line = 0;
  let firstOnLine = true;
  const push = (token: Omit<Token, "line">) => {
    out.push({ ...token, line });
    firstOnLine = false;
  };

  while (index < source.length) {
    const ch = source[index]!;
    if (ch === "\n") {
      line += 1;
      firstOnLine = true;
      index += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\f") {
      index += 1;
      continue;
    }
    if (ch === "\\" && source[index + 1] === "\n") {
      index += 2;
      line += 1;
      continue;
    }
    if (ch === "#") {
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }

    let prefix = "";
    if (ch !== "'" && ch !== '"') {
      PYTHON_STRING_PREFIX.lastIndex = index;
      const match = PYTHON_STRING_PREFIX.exec(source);
      if (match && PYTHON_STRING_PREFIXES.has(match[0].toLowerCase())) prefix = match[0].toLowerCase();
    }
    const quoteIndex = index + prefix.length;
    const quote = source[quoteIndex];
    if ((prefix !== "" || ch === "'" || ch === '"') && (quote === "'" || quote === '"')) {
      const triple = source.startsWith(quote.repeat(3), quoteIndex);
      const delimiter = triple ? quote.repeat(3) : quote;
      const raw = prefix.includes("r");
      let cursor = quoteIndex + delimiter.length;
      let value = "";
      let body = "";
      let dynamic = false;
      let closed = false;
      while (cursor < source.length) {
        if (source.startsWith(delimiter, cursor)) {
          closed = true;
          cursor += delimiter.length;
          break;
        }
        const current = source[cursor]!;
        if (current === "\n" && !triple) break;
        if (current === "\\") {
          const next = source[cursor + 1];
          if (next === undefined) break;
          if (raw) {
            value += `\\${next}`;
            body += `\\${next}`;
            cursor += 2;
          } else {
            const cooked = cookPythonEscape(source, cursor + 1);
            value += cooked.text;
            body += source.slice(cursor, cooked.next);
            if (cooked.unknown) dynamic = true;
            cursor = cooked.next;
          }
          continue;
        }
        value += current;
        body += current;
        cursor += 1;
      }
      if (!closed) throw new LexError("unterminated Python string literal");
      const newlines = (source.slice(index, cursor).match(/\n/g) ?? []).length;
      let expressions: string[] | undefined = [];
      if (prefix.includes("f") && /[{}]/.test(body)) {
        dynamic = true;
        expressions = fstringExpressions(body);
        if (expressions === undefined) throw new LexError("malformed f-string");
      }
      push({ kind: "string", text: prefix, value, dynamic });
      if (dynamic && expressions.length > 0) {
        out.push({ kind: "tpl-start", text: "", line });
        for (const expression of expressions) lexPython(expression, out, true);
        out.push({ kind: "tpl-end", text: "", line });
      }
      line += newlines;
      index = cursor;
      continue;
    }

    if (matchesAt(IDENT_START, source, index)) {
      const end = readIdentifier(source, index, IDENT_START, IDENT_PART);
      push({ kind: "ident", text: source.slice(index, end).normalize("NFKC") });
      index = end;
      continue;
    }
    if (/[0-9]/.test(ch)) {
      let end = index + 1;
      while (end < source.length && /[\w.]/.test(source[end]!)) end += 1;
      push({ kind: "number", text: source.slice(index, end) });
      index = end;
      continue;
    }

    if (ch === "!" && source[index + 1] !== "=" && !inFString) {
      const folded = readFoldedLine(source, index + 1);
      push({ kind: "shell", text: folded.text.trim() });
      index = folded.end;
      line += folded.newlines;
      continue;
    }
    if (ch === "%" && !inFString) {
      const previous = out[out.length - 1];
      if (firstOnLine || (isPunct(previous, "=") && previous?.line === line)) {
        if (firstOnLine && source[index + 1] === "%") {
          const lineEnd = source.indexOf("\n", index);
          const head = source.slice(index + 2, lineEnd < 0 ? source.length : lineEnd).trim();
          const name = /^[A-Za-z_]\w*/.exec(head)?.[0] ?? "";
          const body = lineEnd < 0 ? "" : source.slice(lineEnd + 1);
          push({ kind: "cell-magic", text: name, value: body });
          return;
        }
        const folded = readFoldedLine(source, index + 1);
        const head = folded.text.trimStart();
        const name = /^[A-Za-z_]\w*/.exec(head)?.[0] ?? "";
        push({ kind: "magic", text: name, value: head.slice(name.length).trim() });
        index = folded.end;
        line += folded.newlines;
        continue;
      }
    }

    const pair = source.slice(index, index + 2);
    if (PYTHON_TWO_CHAR_PUNCT.has(pair)) {
      push({ kind: "punct", text: pair });
      index += 2;
      continue;
    }
    push({ kind: "punct", text: ch });
    index += 1;
  }
}

const JS_THREE_CHAR_PUNCT = new Set(["...", "===", "!==", "**=", ">>>", "<<=", ">>=", "&&=", "||=", "??="]);
const JS_TWO_CHAR_PUNCT = new Set([
  "=>",
  "==",
  "!=",
  "<=",
  ">=",
  "&&",
  "||",
  "??",
  "?.",
  "**",
  "++",
  "--",
  "<<",
  ">>",
  "+=",
  "-=",
  "*=",
  "/=",
  "%=",
  "&=",
  "|=",
  "^=",
]);
const JS_REGEX_PRECEDING_KEYWORDS = new Set([
  "return",
  "typeof",
  "instanceof",
  "in",
  "of",
  "new",
  "delete",
  "void",
  "throw",
  "case",
  "do",
  "else",
  "yield",
  "await",
]);
const JS_VALUE_ENDING_PUNCT = new Set([")", "]", "}", "++", "--"]);

function regexAllowedAfter(previous: Token | undefined): boolean {
  if (!previous) return true;
  switch (previous.kind) {
    case "punct":
      return !JS_VALUE_ENDING_PUNCT.has(previous.text);
    case "ident":
      return JS_REGEX_PRECEDING_KEYWORDS.has(previous.text);
    case "tpl-start":
      return true;
    default:
      return false;
  }
}

type JsLexState = { index: number; line: number };

function lexJsTokens(source: string, state: JsLexState, out: Token[], nested: boolean): void {
  let braceDepth = 0;
  const push = (token: Omit<Token, "line">) => out.push({ ...token, line: state.line });

  while (state.index < source.length) {
    const ch = source[state.index]!;
    const next = source[state.index + 1];
    if (ch === "\n") {
      state.line += 1;
      state.index += 1;
      continue;
    }
    if (ch === " " || ch === "\t" || ch === "\f" || ch === "\v" || ch === "\u00a0" || ch === "\ufeff") {
      state.index += 1;
      continue;
    }
    if (ch === "#" && next === "!" && state.index === 0) {
      while (state.index < source.length && source[state.index] !== "\n") state.index += 1;
      continue;
    }
    if (ch === "/" && next === "/") {
      while (state.index < source.length && source[state.index] !== "\n") state.index += 1;
      continue;
    }
    if (ch === "/" && next === "*") {
      const end = source.indexOf("*/", state.index + 2);
      if (end < 0) throw new LexError("unterminated JavaScript comment");
      state.line += (source.slice(state.index, end).match(/\n/g) ?? []).length;
      state.index = end + 2;
      continue;
    }

    if (ch === "'" || ch === '"') {
      let cursor = state.index + 1;
      let value = "";
      let closed = false;
      while (cursor < source.length) {
        const current = source[cursor]!;
        if (current === ch) {
          closed = true;
          cursor += 1;
          break;
        }
        if (current === "\n") break;
        if (current === "\\") {
          const cooked = cookJsEscape(source, cursor + 1);
          if (source[cursor + 1] === "\n") state.line += 1;
          value += cooked.text;
          cursor = cooked.next;
          continue;
        }
        value += current;
        cursor += 1;
      }
      if (!closed) throw new LexError("unterminated JavaScript string literal");
      push({ kind: "string", text: "", value });
      state.index = cursor;
      continue;
    }

    if (ch === "`") {
      const start = state.index + 1;
      let cursor = start;
      let value = "";
      let dynamic = false;
      const inner: Token[][] = [];
      let closed = false;
      while (cursor < source.length) {
        const current = source[cursor]!;
        if (current === "`") {
          closed = true;
          break;
        }
        if (current === "\\") {
          const cooked = cookJsEscape(source, cursor + 1);
          if (source[cursor + 1] === "\n") state.line += 1;
          value += cooked.text;
          cursor = cooked.next;
          continue;
        }
        if (current === "$" && source[cursor + 1] === "{") {
          dynamic = true;
          state.index = cursor + 2;
          const tokens: Token[] = [];
          lexJsTokens(source, state, tokens, true);
          inner.push(tokens);
          cursor = state.index;
          continue;
        }
        if (current === "\n") state.line += 1;
        value += current;
        cursor += 1;
      }
      if (!closed) throw new LexError("unterminated JavaScript template literal");
      push({ kind: "string", text: "", value, raw: source.slice(start, cursor), dynamic, template: true });
      if (dynamic) {
        push({ kind: "tpl-start", text: "" });
        for (const tokens of inner) out.push(...tokens);
        push({ kind: "tpl-end", text: "" });
      }
      state.index = cursor + 1;
      continue;
    }

    if (ch === "}" && nested && braceDepth === 0) {
      state.index += 1;
      return;
    }

    if (ch === "/" && regexAllowedAfter(out[out.length - 1])) {
      let cursor = state.index + 1;
      let inClass = false;
      let closed = false;
      while (cursor < source.length) {
        const current = source[cursor]!;
        if (current === "\n") break;
        if (current === "\\") {
          cursor += 2;
          continue;
        }
        if (current === "[") inClass = true;
        else if (current === "]") inClass = false;
        else if (current === "/" && !inClass) {
          closed = true;
          cursor += 1;
          break;
        }
        cursor += 1;
      }
      if (!closed) throw new LexError("unterminated JavaScript regular expression");
      while (cursor < source.length && /[A-Za-z]/.test(source[cursor]!)) cursor += 1;
      push({ kind: "string", text: "", value: "", dynamic: true });
      state.index = cursor;
      continue;
    }

    if (ch === "\\") throw new LexError("escape sequence outside a string");
    if (matchesAt(JS_IDENT_START, source, state.index)) {
      const end = readIdentifier(source, state.index, JS_IDENT_START, JS_IDENT_PART);
      push({ kind: "ident", text: source.slice(state.index, end) });
      state.index = end;
      continue;
    }
    if (/[0-9]/.test(ch) || (ch === "." && /[0-9]/.test(next ?? ""))) {
      let end = state.index + 1;
      while (end < source.length && /[\w.]/.test(source[end]!)) end += 1;
      push({ kind: "number", text: source.slice(state.index, end) });
      state.index = end;
      continue;
    }

    const triple = source.slice(state.index, state.index + 3);
    if (JS_THREE_CHAR_PUNCT.has(triple)) {
      push({ kind: "punct", text: triple });
      state.index += 3;
      continue;
    }
    const pair = source.slice(state.index, state.index + 2);
    if (JS_TWO_CHAR_PUNCT.has(pair)) {
      push({ kind: "punct", text: pair });
      state.index += 2;
      continue;
    }
    if (ch === "{") braceDepth += 1;
    else if (ch === "}") braceDepth -= 1;
    push({ kind: "punct", text: ch });
    state.index += 1;
  }
  if (nested) throw new LexError("unterminated template expression");
}

function lexJavaScript(source: string, out: Token[]): void {
  lexJsTokens(normalizeNewlines(source), { index: 0, line: 0 }, out, false);
}

// ---------------------------------------------------------------------------
// Parsing helpers shared by both languages
// ---------------------------------------------------------------------------

const OPENERS = new Set(["(", "[", "{"]);
const CLOSERS = new Set([")", "]", "}"]);

function isOpener(token: Token): boolean {
  return token.kind === "tpl-start" || (token.kind === "punct" && OPENERS.has(token.text));
}

function isCloser(token: Token): boolean {
  return token.kind === "tpl-end" || (token.kind === "punct" && CLOSERS.has(token.text));
}

/** Index of the token closing the bracket at `open`, or -1. */
function matchingClose(tokens: Token[], open: number): number {
  let depth = 0;
  for (let index = open; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (isOpener(token)) depth += 1;
    else if (isCloser(token)) {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  return -1;
}

/** Split bracket contents at top-level commas. A trailing comma adds no empty element. */
function splitTopLevel(tokens: Token[]): Token[][] {
  const parts: Token[][] = [];
  let current: Token[] = [];
  let depth = 0;
  for (const token of tokens) {
    if (depth === 0 && isPunct(token, ",")) {
      parts.push(current);
      current = [];
      continue;
    }
    if (isOpener(token)) depth += 1;
    else if (isCloser(token)) depth -= 1;
    current.push(token);
  }
  if (current.length > 0) parts.push(current);
  return parts;
}

function callArguments(tokens: Token[], open: number): Token[][] | undefined {
  if (!isPunct(tokens[open], "(")) return undefined;
  const close = matchingClose(tokens, open);
  if (close < 0) return undefined;
  return splitTopLevel(tokens.slice(open + 1, close));
}

/**
 * Evaluate tokens that are a literal string expression: adjacent literals
 * (Python), `+` concatenation of literals, and parentheses around either.
 * Anything computed returns undefined.
 */
function parseStringExpression(tokens: Token[], implicitConcat: boolean): string | undefined {
  let index = 0;
  let result = "";
  const parseTerm = (): boolean => {
    const first = tokens[index];
    if (isPunct(first, "(")) {
      const close = matchingClose(tokens, index);
      if (close < 0) return false;
      const inner = parseStringExpression(tokens.slice(index + 1, close), implicitConcat);
      if (inner === undefined) return false;
      result += inner;
      index = close + 1;
      return true;
    }
    if (first?.kind !== "string" || first.dynamic) return false;
    result += first.value ?? "";
    index += 1;
    while (implicitConcat && tokens[index]?.kind === "string") {
      const part = tokens[index]!;
      if (part.dynamic) return false;
      result += part.value ?? "";
      index += 1;
    }
    return true;
  };
  if (tokens.length === 0 || !parseTerm()) return undefined;
  while (index < tokens.length) {
    if (!isPunct(tokens[index], "+")) return undefined;
    index += 1;
    if (!parseTerm()) return undefined;
  }
  return result;
}

/** A list/tuple/array whose every element is a literal string expression. */
function parseStringList(tokens: Token[], implicitConcat: boolean, allowTuple: boolean): string[] | undefined {
  const first = tokens[0];
  const isArray = isPunct(first, "[");
  if (!isArray && !(allowTuple && isPunct(first, "("))) return undefined;
  const close = matchingClose(tokens, 0);
  if (close !== tokens.length - 1) return undefined;
  const parts = splitTopLevel(tokens.slice(1, close));
  if (parts.length === 0) return undefined;
  if (!isArray && parts.length === 1 && !isPunct(tokens[close - 1], ",")) return undefined;
  const words: string[] = [];
  for (const part of parts) {
    const word = parseStringExpression(part, implicitConcat);
    if (word === undefined) return undefined;
    words.push(word);
  }
  return words;
}

type Operand = { kind: "string"; value: string } | { kind: "argv"; argv: string[] };

function parseCommandOperand(tokens: Token[], python: boolean): Operand | undefined {
  const value = parseStringExpression(tokens, python);
  if (value !== undefined) return { kind: "string", value };
  const argv = parseStringList(tokens, python, python);
  return argv === undefined ? undefined : { kind: "argv", argv };
}

// ---------------------------------------------------------------------------
// Python extraction
// ---------------------------------------------------------------------------

const PY_PROCESS_CALLS = new Set(["run", "call", "check_call", "check_output", "Popen"]);
const PY_SUBPROCESS_SHELL_CALLS = new Set(["getoutput", "getstatusoutput"]);
const PY_SUBPROCESS_HARMLESS = new Set([
  "PIPE",
  "STDOUT",
  "DEVNULL",
  "CalledProcessError",
  "TimeoutExpired",
  "CompletedProcess",
  "SubprocessError",
]);
const PY_OS_SHELL_CALLS = new Set(["system", "popen"]);
const PY_OS_DANGEROUS_ATTRIBUTE = /^(system|popen\d?|exec\w*|spawn\w*|posix_spawn\w*|fork\w*|startfile|chdir|fchdir)$/;
const PY_SPAWN_NAMES = new Set([
  "Popen",
  "check_output",
  "check_call",
  "getoutput",
  "getstatusoutput",
  "create_subprocess_exec",
  "create_subprocess_shell",
  "subprocess_exec",
  "subprocess_shell",
  "posix_spawn",
  "posix_spawnp",
  "startfile",
  "forkpty",
  "popen2",
  "popen3",
  "popen4",
]);
const PY_OPAQUE_WORDS = new Set([
  "ctypes",
  "cffi",
  "pty",
  "importlib",
  "import_module",
  "__import__",
  "getattr",
  "__builtins__",
  "builtins",
  "__dict__",
  "__globals__",
  "__subclasses__",
  "__bases__",
  "__mro__",
  "__getattribute__",
  "__loader__",
  "runpy",
  "pickle",
  "marshal",
  "pexpect",
  "plumbum",
  "paramiko",
  "posix",
  "nt",
  "_posixsubprocess",
  "get_ipython",
  "commands",
  "globals",
  "locals",
  "vars",
]);
const PY_BUILTIN_EXECUTORS = new Set(["exec", "eval", "compile"]);
const PY_SAFE_LINE_MAGICS = new Set(["pwd", "ls", "env", "set_env", "who", "whos", "reset"]);
const PY_BENIGN_KEYWORDS = new Set([
  "stdin",
  "stdout",
  "stderr",
  "input",
  "capture_output",
  "text",
  "universal_newlines",
  "encoding",
  "errors",
  "timeout",
  "check",
  "bufsize",
  "close_fds",
  "start_new_session",
  "restore_signals",
  "limit",
]);
const PY_SHELL_HELPER = "__omp_shell";
const PY_OMP_INTERNAL_PREFIX = "__omp_";

type PythonCall = { positional: Token[][]; keywords: Map<string, Token[]>; unpack: boolean };

function parsePythonCall(tokens: Token[], open: number): PythonCall | undefined {
  const args = callArguments(tokens, open);
  if (!args) return undefined;
  const call: PythonCall = { positional: [], keywords: new Map(), unpack: false };
  for (const arg of args) {
    if (isPunct(arg[0], "*")) {
      call.unpack = true;
    } else if (isIdent(arg[0]) && isPunct(arg[1], "=")) {
      call.keywords.set(arg[0]!.text, arg.slice(2));
    } else {
      call.positional.push(arg);
    }
  }
  return call;
}

/** Keywords that name the command operand, which is parsed separately. */
const PY_OPERAND_KEYWORDS = new Set(["args", "cmd", "command"]);

/** Validate `subprocess`-style keywords; returns the literal `shell` and `cwd` values. */
function pythonKeywordOptions(
  collector: Collector,
  origin: string,
  keywords: Map<string, Token[]>,
): { shell: boolean; cwd?: string } {
  const options: { shell: boolean; cwd?: string } = { shell: false };
  for (const [key, value] of keywords) {
    if (key === "shell") {
      if (value.length === 1 && isIdent(value[0], "True")) options.shell = true;
      else if (!(value.length === 1 && isIdent(value[0], "False"))) {
        addOpaque(collector, `${origin}: shell= is not a literal True/False`);
      }
    } else if (key === "cwd") {
      const cwd = parseStringExpression(value, true);
      if (cwd !== undefined) options.cwd = cwd;
      else if (!(value.length === 1 && isIdent(value[0], "None"))) {
        addOpaque(collector, `${origin}: cwd= is not a literal string`);
      }
    } else if (!PY_BENIGN_KEYWORDS.has(key) && !PY_OPERAND_KEYWORDS.has(key)) {
      addOpaque(collector, `${origin}: ${key}= option is not analyzed`);
    }
  }
  return options;
}

function handlePythonProcessCall(
  tokens: Token[],
  open: number,
  origin: string,
  collector: Collector,
  kind: "popen" | "shell" | "async-shell" | "async-exec",
): void {
  const call = parsePythonCall(tokens, open);
  if (!call) {
    addOpaque(collector, `${origin}: call arguments are not balanced`);
    return;
  }
  if (call.unpack) addOpaque(collector, `${origin}: argument unpacking is not analyzed`);

  const options = kind === "shell" ? { shell: false, cwd: undefined } : pythonKeywordOptions(collector, origin, call.keywords);

  if (kind === "async-exec") {
    if (call.unpack || call.positional.length === 0) {
      addOpaque(collector, `${origin}: program and arguments are not literal`);
      return;
    }
    const argv = call.positional.map((arg) => parseStringExpression(arg, true));
    if (argv.some((word) => word === undefined)) {
      addOpaque(collector, `${origin}: program and arguments are not literal`);
      return;
    }
    addCommand(collector, withWorkingDirectory(renderArgv(argv as string[]), options.cwd), origin);
    return;
  }

  const operandTokens = call.positional[0] ?? call.keywords.get(kind === "popen" ? "args" : "command") ?? call.keywords.get("cmd");
  if (kind === "popen" && call.positional.length > 1) {
    addOpaque(collector, `${origin}: positional options are not analyzed`);
  }
  const operand = operandTokens ? parseCommandOperand(operandTokens, true) : undefined;
  if (!operand || (kind !== "popen" && operand.kind !== "string")) {
    addOpaque(collector, `${origin}: command is not a literal`);
    return;
  }
  let command: string;
  if (operand.kind === "string") command = operand.value;
  else if (options.shell) command = operand.argv[0] ?? "";
  else command = renderArgv(operand.argv);
  addCommand(collector, withWorkingDirectory(command, options.cwd), origin);
}

/** `import name` / `import a, name` with no alias. */
function isPlainPythonImportName(tokens: Token[], index: number): boolean {
  if (isIdent(tokens[index + 1], "as")) return false;
  let cursor = index - 1;
  while (cursor >= 0) {
    const token = tokens[cursor]!;
    if (isPunct(token, ",") || (isIdent(token) && !["import", "from", "as"].includes(token.text))) {
      cursor -= 1;
      continue;
    }
    break;
  }
  return isIdent(tokens[cursor], "import") && !isPunct(tokens[index + 1], ".");
}

function extractPython(tokens: Token[], collector: Collector): void {
  const consumed = new Set<number>();

  for (const token of tokens) {
    if (token.kind === "shell") {
      if (token.text !== "") addCommand(collector, token.text, "IPython !");
    } else if (token.kind === "magic") {
      if (!PY_SAFE_LINE_MAGICS.has(token.text)) addOpaque(collector, `IPython magic %${token.text} is not analyzed`);
    } else if (token.kind === "cell-magic") {
      if (token.text === "bash") addCommand(collector, token.value ?? "", "IPython %%bash");
      else addOpaque(collector, `IPython cell magic %%${token.text} is not analyzed`);
    }
  }

  // `from os import a, b` binds names the scanner cannot track afterwards, so
  // any process-spawning or directory-changing name makes the eval opaque.
  for (let index = 0; index < tokens.length; index += 1) {
    if (!(isIdent(tokens[index], "from") && isIdent(tokens[index + 1], "os") && isIdent(tokens[index + 2], "import"))) {
      continue;
    }
    consumed.add(index + 1);
    if (isPunct(tokens[index + 3], "*")) addOpaque(collector, "from os import * is not analyzed");
    const parenthesized = isPunct(tokens[index + 3], "(");
    for (let cursor = index + 3; cursor < tokens.length; cursor += 1) {
      const name = tokens[cursor]!;
      if (parenthesized ? isPunct(name, ")") : name.line !== tokens[index]!.line) break;
      if (isIdent(name) && PY_OS_DANGEROUS_ATTRIBUTE.test(name.text)) {
        addOpaque(collector, `from os import ${name.text} is not analyzed`);
      }
    }
  }

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (token.kind !== "ident" || consumed.has(index)) continue;
    const name = token.text;
    const afterDot = isPunct(tokens[index - 1], ".");
    const open = index + 3;

    if (name === "subprocess") {
      const attribute = tokens[index + 2];
      if (isPunct(tokens[index + 1], ".") && isIdent(attribute)) {
        consumed.add(index + 2);
        if (PY_PROCESS_CALLS.has(attribute!.text) && isPunct(tokens[open], "(")) {
          handlePythonProcessCall(tokens, open, `subprocess.${attribute!.text}`, collector, "popen");
        } else if (PY_SUBPROCESS_SHELL_CALLS.has(attribute!.text) && isPunct(tokens[open], "(")) {
          handlePythonProcessCall(tokens, open, `subprocess.${attribute!.text}`, collector, "shell");
        } else if (!PY_SUBPROCESS_HARMLESS.has(attribute!.text)) {
          addOpaque(collector, `subprocess.${attribute!.text} is used without a literal call`);
        }
      } else if (!isPlainPythonImportName(tokens, index)) {
        addOpaque(collector, "subprocess is aliased or used as a value");
      }
      continue;
    }

    if (name === "os" && !afterDot) {
      const attribute = tokens[index + 2];
      if (isPunct(tokens[index + 1], ".") && isIdent(attribute)) {
        if (PY_OS_SHELL_CALLS.has(attribute!.text) && isPunct(tokens[open], "(")) {
          consumed.add(index + 2);
          handlePythonProcessCall(tokens, open, `os.${attribute!.text}`, collector, "shell");
        } else if (PY_OS_DANGEROUS_ATTRIBUTE.test(attribute!.text)) {
          consumed.add(index + 2);
          addOpaque(collector, `os.${attribute!.text} is used without a literal shell call`);
        }
      } else if (!isPlainPythonImportName(tokens, index)) {
        addOpaque(collector, "os is aliased or used as a value");
      }
      continue;
    }

    if (name === "asyncio" && isPunct(tokens[index + 1], ".") && isIdent(tokens[index + 2])) {
      const attribute = tokens[index + 2]!.text;
      if (isPunct(tokens[open], "(") && (attribute === "create_subprocess_shell" || attribute === "create_subprocess_exec")) {
        consumed.add(index + 2);
        handlePythonProcessCall(
          tokens,
          open,
          `asyncio.${attribute}`,
          collector,
          attribute === "create_subprocess_shell" ? "async-shell" : "async-exec",
        );
      }
      continue;
    }

    if (name === PY_SHELL_HELPER && isPunct(tokens[index + 1], "(")) {
      handlePythonProcessCall(tokens, index + 1, PY_SHELL_HELPER, collector, "shell");
      continue;
    }
    if (name.startsWith(PY_OMP_INTERNAL_PREFIX)) {
      addOpaque(collector, `${name} is an OMP runner internal`);
    } else if (PY_OPAQUE_WORDS.has(name)) {
      addOpaque(collector, `references ${name}, which can run code the scanner cannot see`);
    } else if (!afterDot && PY_BUILTIN_EXECUTORS.has(name)) {
      addOpaque(collector, `calls ${name}(), which runs code the scanner cannot see`);
    } else if (PY_SPAWN_NAMES.has(name)) {
      addOpaque(collector, `${name} is used outside a literal subprocess call`);
    } else if (name === "modules" && afterDot && isIdent(tokens[index - 2], "sys")) {
      addOpaque(collector, "references sys.modules");
    } else if (name === "os" && afterDot) {
      continue;
    }
  }
}

// ---------------------------------------------------------------------------
// JavaScript extraction
// ---------------------------------------------------------------------------

const CHILD_PROCESS_MODULE = "child_process";
const BUN_MODULE = "bun";
const NODE_MODULE_PREFIX = "node:";
const JS_OPAQUE_MODULES = new Set(["vm", "worker_threads", "cluster", "module", "repl", "bun:ffi", "v8"]);
const JS_SYNC_SPAWN_NAMES = new Set(["execSync", "spawnSync", "execFileSync"]);
const JS_ASYNC_SPAWN_NAMES = new Set(["exec", "execFile", "spawn", "fork"]);
const JS_SHELL_STRING_NAMES = new Set(["exec", "execSync"]);
const JS_CHILD_PROCESS_RECEIVER = /^(cp|child_?process|child|sh|shell)$/i;
const JS_OPAQUE_GLOBALS = new Set(["eval", "Function", "Worker"]);
const JS_PROCESS_OPAQUE_ATTRIBUTES = new Set(["binding", "dlopen", "chdir", "mainModule", "_linkedBinding", "reallyExit"]);
const JS_BENIGN_OPTIONS = new Set([
  "stdio",
  "encoding",
  "timeout",
  "maxBuffer",
  "windowsHide",
  "detached",
  "killSignal",
  "signal",
  "input",
  "argv0",
  "stdout",
  "stderr",
  "stdin",
  "onExit",
  "ipc",
  "serialization",
  "windowsVerbatimArguments",
]);
const JS_DECLARATION_KEYWORDS = new Set(["const", "let", "var"]);
const BUN_SHELL_NAME = "$";

type JsOptions = { shell: boolean; cwd?: string; cmd?: Token[] };

function jsOptionKeyName(entry: Token[]): string | undefined {
  const key = entry[0];
  if (key?.kind === "ident" || (key?.kind === "string" && !key.dynamic)) return key.kind === "ident" ? key.text : key.value;
  return undefined;
}

function readJsOptions(collector: Collector, origin: string, tokens: Token[] | undefined, allowCmd: boolean): JsOptions {
  const options: JsOptions = { shell: false };
  if (!tokens) return options;
  const close = matchingClose(tokens, 0);
  if (!isPunct(tokens[0], "{") || close !== tokens.length - 1) {
    addOpaque(collector, `${origin}: options are not an object literal`);
    return options;
  }
  for (const entry of splitTopLevel(tokens.slice(1, close))) {
    const key = jsOptionKeyName(entry);
    if (key === undefined || !isPunct(entry[1], ":")) {
      addOpaque(collector, `${origin}: options use shorthand, spread, or computed keys`);
      continue;
    }
    const value = entry.slice(2);
    if (key === "shell") {
      if (value.length === 1 && isIdent(value[0], "true")) options.shell = true;
      else if (parseStringExpression(value, false) !== undefined) options.shell = true;
      else if (!(value.length === 1 && isIdent(value[0], "false"))) {
        addOpaque(collector, `${origin}: shell option is not a literal`);
      }
    } else if (key === "cwd") {
      const cwd = parseStringExpression(value, false);
      if (cwd !== undefined) options.cwd = cwd;
      else if (!(value.length === 1 && isIdent(value[0], "undefined"))) {
        addOpaque(collector, `${origin}: cwd option is not a literal string`);
      }
    } else if (key === "cmd" && allowCmd) {
      options.cmd = value;
    } else if (!JS_BENIGN_OPTIONS.has(key)) {
      addOpaque(collector, `${origin}: ${key} option is not analyzed`);
    }
  }
  return options;
}

function handleNodeSpawnCall(
  tokens: Token[],
  nameIndex: number,
  name: string,
  origin: string,
  collector: Collector,
): void {
  const args = callArguments(tokens, nameIndex + 1);
  if (!args) {
    addOpaque(collector, `${origin}: call arguments are not balanced`);
    return;
  }
  if (name === "fork") {
    addOpaque(collector, `${origin} starts a Node script whose code is not analyzed`);
    return;
  }
  if (args.some((arg) => isPunct(arg[0], "..."))) addOpaque(collector, `${origin}: argument spread is not analyzed`);

  const rest = args.slice(1);
  let argvTokens: Token[] | undefined;
  if (!JS_SHELL_STRING_NAMES.has(name) && rest[0] && !isPunct(rest[0][0], "{") && !looksLikeCallback(rest[0])) {
    argvTokens = rest.shift();
  }
  const options = readJsOptions(collector, origin, findJsOptions(collector, origin, rest), false);
  const first = args[0] ? parseStringExpression(args[0], false) : undefined;
  if (first === undefined) {
    addOpaque(collector, `${origin}: command is not a literal`);
    return;
  }
  if (JS_SHELL_STRING_NAMES.has(name)) {
    addCommand(collector, withWorkingDirectory(first, options.cwd), origin);
    return;
  }
  let argv: string[] = [];
  if (argvTokens) {
    const list = parseStringList(argvTokens, false, false);
    if (list === undefined) {
      addOpaque(collector, `${origin}: arguments are not literal`);
      addCommand(collector, withWorkingDirectory(renderArgv([first]), options.cwd), origin);
      return;
    }
    argv = list;
  }
  // With `shell: true` Node joins command and arguments without quoting.
  const command = options.shell ? [first, ...argv].join(" ") : renderArgv([first, ...argv]);
  addCommand(collector, withWorkingDirectory(command, options.cwd), origin);
}

/** An arrow function or function expression, which only receives results and is scanned like any other code. */
function looksLikeCallback(tokens: Token[]): boolean {
  const first = tokens[0];
  if (isIdent(first, "function") || isIdent(first, "async")) return true;
  if (isIdent(first)) return isPunct(tokens[1], "=>");
  if (!isPunct(first, "(")) return false;
  const close = matchingClose(tokens, 0);
  return close >= 0 && isPunct(tokens[close + 1], "=>");
}

/** The options object among trailing call arguments; any other non-callback argument is opaque. */
function findJsOptions(collector: Collector, origin: string, extras: Token[][]): Token[] | undefined {
  let found: Token[] | undefined;
  for (const extra of extras) {
    if (isPunct(extra[0], "{")) found ??= extra;
    else if (!looksLikeCallback(extra)) addOpaque(collector, `${origin}: options are not an object literal`);
  }
  return found;
}

function handleBunSpawnCall(tokens: Token[], nameIndex: number, origin: string, collector: Collector): void {
  const args = callArguments(tokens, nameIndex + 1);
  if (!args) {
    addOpaque(collector, `${origin}: call arguments are not balanced`);
    return;
  }
  const objectCommand = isPunct(args[0]?.[0], "{");
  const optionTokens = findJsOptions(collector, origin, objectCommand ? [args[0]!] : args.slice(1));
  const options = readJsOptions(collector, origin, optionTokens, true);
  const cmdTokens: Token[] | undefined = objectCommand ? options.cmd : args[0];
  const argv = cmdTokens ? parseStringList(cmdTokens, false, false) : undefined;
  if (argv === undefined) {
    addOpaque(collector, `${origin}: command array is not literal`);
    return;
  }
  addCommand(collector, withWorkingDirectory(renderArgv(argv), options.cwd), origin);
}

function normalizeModuleName(name: string): string {
  return name.startsWith(NODE_MODULE_PREFIX) ? name.slice(NODE_MODULE_PREFIX.length) : name;
}

type JsBindings = {
  /** Identifiers bound to the whole child_process module. */
  namespaces: Set<string>;
  /** Local name -> imported child_process function name. */
  renamed: Map<string, string>;
  consumed: Set<number>;
};

/** Parse `{ a, b: c }` destructuring or `{ a, b as c }` import lists between `open` and `close`. */
function bindNamedImports(
  tokens: Token[],
  open: number,
  close: number,
  separator: string,
  bindings: JsBindings,
  collector: Collector,
  moduleName: string,
): void {
  for (const entry of splitTopLevel(tokens.slice(open + 1, close))) {
    const imported = entry[0];
    const aliased = entry.length === 3 && (entry[1]?.text === separator) && isIdent(entry[2]);
    if (!isIdent(imported) || !(entry.length === 1 || aliased)) {
      addOpaque(collector, `${moduleName} binding uses defaults, nesting, or string keys`);
      continue;
    }
    const importedIndex = open + 1 + tokens.slice(open + 1, close).indexOf(imported!);
    bindings.consumed.add(importedIndex);
    const local = aliased ? entry[2]!.text : imported!.text;
    if (aliased) bindings.consumed.add(importedIndex + 2);
    if (moduleName === BUN_MODULE) {
      if (imported!.text === BUN_SHELL_NAME && local !== BUN_SHELL_NAME) {
        addOpaque(collector, "Bun shell is renamed on import");
      } else if ((imported!.text === "spawn" || imported!.text === "spawnSync") && local !== imported!.text) {
        bindings.renamed.set(local, imported!.text);
      }
    } else if (local !== imported!.text) {
      bindings.renamed.set(local, imported!.text);
    }
  }
}

function collectJsBindings(tokens: Token[], collector: Collector): JsBindings {
  const bindings: JsBindings = { namespaces: new Set(), renamed: new Map(), consumed: new Set() };

  const classify = (moduleName: string): "child_process" | "bun" | "other" => {
    const name = normalizeModuleName(moduleName);
    if (JS_OPAQUE_MODULES.has(name) || JS_OPAQUE_MODULES.has(moduleName)) {
      addOpaque(collector, `loads module ${moduleName}, which can run code the scanner cannot see`);
      return "other";
    }
    if (name === CHILD_PROCESS_MODULE) return "child_process";
    if (name === BUN_MODULE) return "bun";
    return "other";
  };

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;
    if (!isIdent(token, "require") && !isIdent(token, "import")) continue;
    if (isPunct(tokens[index - 1], ".")) continue;

    // import.meta
    if (isIdent(token, "import") && isPunct(tokens[index + 1], ".")) continue;

    const isCall = isPunct(tokens[index + 1], "(");
    if (isCall) {
      const argument = tokens[index + 2];
      if (argument?.kind !== "string" || argument.dynamic || !isPunct(tokens[index + 3], ")")) {
        addOpaque(collector, `${token.text}() has a non-literal module specifier`);
        continue;
      }
      const kind = classify(argument.value ?? "");
      if (kind === "other") continue;
      const moduleName = kind;
      const end = index + 3;
      let start = index - 1;
      let wrappers = 0;
      while (start >= 0 && (isIdent(tokens[start], "await") || isPunct(tokens[start], "("))) {
        if (isPunct(tokens[start], "(")) wrappers += 1;
        start -= 1;
      }
      let after = end + 1;
      for (let remaining = wrappers; remaining > 0 && isPunct(tokens[after], ")"); remaining -= 1) after += 1;

      if (isPunct(tokens[start], "=")) {
        const target = tokens[start - 1];
        if (isIdent(target)) {
          bindings.consumed.add(start - 1);
          if (kind === "child_process") bindings.namespaces.add(target!.text);
          else addOpaque(collector, "bun module is bound to a variable");
          continue;
        }
        if (isPunct(target, "}")) {
          let open = start - 1;
          let depth = 0;
          for (; open >= 0; open -= 1) {
            if (isPunct(tokens[open], "}")) depth += 1;
            else if (isPunct(tokens[open], "{")) {
              depth -= 1;
              if (depth === 0) break;
            }
          }
          if (open < 0) {
            addOpaque(collector, `${moduleName} destructuring is malformed`);
            continue;
          }
          bindNamedImports(tokens, open, start - 1, ":", bindings, collector, moduleName);
          continue;
        }
        addOpaque(collector, `${moduleName} is bound with an unsupported pattern`);
        continue;
      }
      if (isPunct(tokens[after], ".") && isIdent(tokens[after + 1])) {
        const member = tokens[after + 1]!;
        if (isPunct(tokens[after + 2], "(")) {
          // Direct call: the name pass below treats `receiver.exec(` after `)` as a child_process call.
          bindings.consumed.add(after + 1);
          if (kind === "child_process") {
            handleNodeSpawnCallByName(tokens, after + 1, collector, `child_process.${member.text}`);
          } else if (member.text === "spawn" || member.text === "spawnSync") {
            handleBunSpawnCall(tokens, after + 1, `bun.${member.text}`, collector);
          }
          continue;
        }
        const assignment = tokens[start];
        if (isPunct(assignment, "=") && isIdent(tokens[start - 1])) bindings.renamed.set(tokens[start - 1]!.text, member.text);
        else addOpaque(collector, `${moduleName}.${member.text} is used as a value`);
        continue;
      }
      addOpaque(collector, `${moduleName} module is used without a binding the scanner understands`);
      continue;
    }

    if (!isIdent(token, "import")) {
      addOpaque(collector, "require is used as a value");
      continue;
    }

    // Static import: `import <clause> from "module"` or `import "module"`.
    const sideEffect = tokens[index + 1];
    if (sideEffect?.kind === "string") {
      classify(sideEffect.value ?? "");
      continue;
    }
    let from = index + 1;
    while (from < tokens.length && !isIdent(tokens[from], "from")) from += 1;
    const specifier = tokens[from + 1];
    if (from >= tokens.length || specifier?.kind !== "string" || specifier.dynamic) {
      addOpaque(collector, "import statement is not understood");
      continue;
    }
    const kind = classify(specifier.value ?? "");
    if (kind === "other") continue;
    const clause = tokens.slice(index + 1, from);
    for (let offset = 0; offset < clause.length; offset += 1) {
      const clauseToken = clause[offset]!;
      const absolute = index + 1 + offset;
      if (isPunct(clauseToken, "{")) {
        const close = matchingClose(tokens, absolute);
        if (close < 0 || close >= from) {
          addOpaque(collector, `${kind} import list is malformed`);
          break;
        }
        bindNamedImports(tokens, absolute, close, "as", bindings, collector, kind);
        offset = close - index - 1;
      } else if (isIdent(clauseToken, "as")) {
        continue;
      } else if (isIdent(clauseToken)) {
        bindings.consumed.add(absolute);
        if (kind === "child_process") bindings.namespaces.add(clauseToken.text);
        else addOpaque(collector, "bun module is bound to a variable");
      }
    }
  }
  return bindings;
}

function handleNodeSpawnCallByName(tokens: Token[], nameIndex: number, collector: Collector, origin: string): void {
  const name = tokens[nameIndex]!.text;
  handleNodeSpawnCall(tokens, nameIndex, name, origin, collector);
}

function extractJavaScript(tokens: Token[], collector: Collector): void {
  const bindings = collectJsBindings(tokens, collector);
  const { consumed, namespaces, renamed } = bindings;

  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]!;

    if (token.kind === "string" && !token.dynamic && isPunct(tokens[index - 1], "[") && isPunct(tokens[index + 1], "]")) {
      const key = token.value ?? "";
      if (JS_SYNC_SPAWN_NAMES.has(key) || JS_ASYNC_SPAWN_NAMES.has(key) || key === "$") {
        addOpaque(collector, `computed member access to ${key}`);
      }
      continue;
    }
    if (token.kind !== "ident" || consumed.has(index)) continue;

    const name = token.text;
    const previous = tokens[index - 1];
    const afterDot = isPunct(previous, ".") || isPunct(previous, "?.");
    const nextIsCall = isPunct(tokens[index + 1], "(");

    if (!afterDot && JS_OPAQUE_GLOBALS.has(name)) {
      addOpaque(collector, `references ${name}, which can run code the scanner cannot see`);
      continue;
    }

    if (name === "process") {
      const attribute = tokens[index + 2];
      const member = isPunct(tokens[index + 1], ".") || isPunct(tokens[index + 1], "?.");
      if (isPunct(tokens[index + 1], "[")) addOpaque(collector, "computed process member access");
      else if (member && isIdent(attribute) && JS_PROCESS_OPAQUE_ATTRIBUTES.has(attribute!.text)) {
        addOpaque(collector, `process.${attribute!.text} is not analyzed`);
      } else if (!member && !isIdent(previous, "typeof")) {
        addOpaque(collector, "process is aliased or used as a value");
      }
      continue;
    }

    if (name === "Bun") {
      const attribute = tokens[index + 2];
      if (!(isPunct(tokens[index + 1], ".") || isPunct(tokens[index + 1], "?.")) || !isIdent(attribute)) {
        addOpaque(collector, "Bun is aliased, indexed, or used as a value");
        continue;
      }
      const attributeName = attribute!.text;
      if ((attributeName === "spawn" || attributeName === "spawnSync") && isPunct(tokens[index + 3], "(")) {
        consumed.add(index + 2);
        handleBunSpawnCall(tokens, index + 2, `Bun.${attributeName}`, collector);
      } else if (attributeName === "spawn" || attributeName === "spawnSync") {
        addOpaque(collector, `Bun.${attributeName} is used without a literal call`);
      } else if (attributeName === BUN_SHELL_NAME) {
        const template = tokens[index + 3];
        if (template?.kind === "string" && template.template && !template.dynamic) {
          addCommand(collector, template.raw ?? "", "Bun.$");
        } else {
          addOpaque(collector, "Bun.$ command is not a literal template");
        }
        consumed.add(index + 2);
      } else if (attributeName === "dlopen") {
        addOpaque(collector, "Bun.dlopen is not analyzed");
      }
      continue;
    }

    if (name === BUN_SHELL_NAME && !afterDot) {
      const template = tokens[index + 1];
      if (template?.kind === "string" && template.template) {
        if (template.dynamic) addOpaque(collector, "Bun $ command has interpolation");
        else addCommand(collector, template.raw ?? "", "Bun $");
      } else {
        addOpaque(collector, "Bun shell $ is used other than as a literal template tag");
      }
      continue;
    }

    if (namespaces.has(name) && !afterDot) {
      if (!(isPunct(tokens[index + 1], ".") || isPunct(tokens[index + 1], "?.")) || !isIdent(tokens[index + 2])) {
        addOpaque(collector, `${name} (child_process) is used as a value`);
      }
      continue;
    }

    const renamedTarget = !afterDot ? renamed.get(name) : undefined;
    if (renamedTarget !== undefined) {
      if (nextIsCall) handleNodeSpawnCall(tokens, index, renamedTarget, name, collector);
      else addOpaque(collector, `${name} (child_process.${renamedTarget}) is used as a value`);
      continue;
    }

    const receiver = afterDot ? tokens[index - 2] : undefined;
    const receiverIsChildProcess = receiver?.kind === "ident" &&
      (namespaces.has(receiver.text) || JS_CHILD_PROCESS_RECEIVER.test(receiver.text));
    if (JS_SYNC_SPAWN_NAMES.has(name) || (JS_ASYNC_SPAWN_NAMES.has(name) && (!afterDot || receiverIsChildProcess))) {
      if (nextIsCall) {
        const origin = receiver?.kind === "ident" && afterDot ? `${receiver.text}.${name}` : name;
        handleNodeSpawnCall(tokens, index, name, origin, collector);
      } else if (!afterDot || receiverIsChildProcess || JS_SYNC_SPAWN_NAMES.has(name)) {
        addOpaque(collector, `${name} is used outside a literal child_process call`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const PERCENT_COMMAND_PREFIX = "%";

function analyzeCell(cell: EvalCell, collector: Collector): void {
  if (cell.code.length > MAX_EVAL_ANALYSIS_LENGTH) {
    addOpaque(collector, `eval code exceeds ${MAX_EVAL_ANALYSIS_LENGTH} characters and was not analyzed`);
    return;
  }
  if (cell.languageGiven && cell.language === undefined) {
    addOpaque(collector, "eval language is not recognized");
  }
  const languages: EvalLanguage[] = cell.language ? [cell.language] : ["py", "js"];
  for (const language of languages) {
    const tokens: Token[] = [];
    try {
      if (language === "py") lexPython(cell.code, tokens);
      else lexJavaScript(cell.code, tokens);
    } catch (error) {
      const message = error instanceof LexError ? error.message : "scanner failure";
      addOpaque(collector, `${language === "py" ? "Python" : "JavaScript"} code could not be tokenized: ${message}`);
    }
    try {
      if (language === "py") extractPython(tokens, collector);
      else {
        if (cell.code.trimStart().startsWith(PERCENT_COMMAND_PREFIX)) {
          addOpaque(collector, "eval percent command is not analyzed");
        }
        extractJavaScript(tokens, collector);
      }
    } catch {
      addOpaque(collector, "eval analysis failed unexpectedly");
    }
  }
}

/** Analyze an `eval` tool call. Never throws; failures become opaque reasons. */
export function analyzeEval(input: Record<string, unknown>): EvalAnalysis {
  const collector: Collector = { commands: [], opaque: [] };
  const { cells, problems } = evalCells(input);
  for (const problem of problems) addOpaque(collector, problem);
  for (const cell of cells) analyzeCell(cell, collector);
  return {
    codeTexts: cells.map((cell) => cell.code),
    language: evalInputLanguage(input),
    commands: collector.commands,
    opaqueReasons: collector.opaque,
  };
}

const MAX_NOTE_COMMAND_LENGTH = 300;

/**
 * Extension-authored lines that tell the classifier what the static scan found.
 * Quoted command text is untrusted data copied from the action.
 */
export function describeEvalAnalysis(analysis: EvalAnalysis): string[] {
  const lines: string[] = [];
  if (analysis.opaqueReasons.length > 0) {
    lines.push(
      "This eval is opaque: the static scan could not fully understand the code, so it may run commands or file operations it did not extract. Review the code itself.",
    );
    for (const reason of analysis.opaqueReasons) lines.push(`- opaque: ${reason}`);
  }
  if (analysis.commands.length > 0) {
    lines.push("Literal shell commands extracted from the code (data, already checked against permission rules and hard-deny checks):");
    for (const { command, origin } of analysis.commands) {
      const shown = command.length > MAX_NOTE_COMMAND_LENGTH ? `${command.slice(0, MAX_NOTE_COMMAND_LENGTH)}…` : command;
      lines.push(`- ${origin}: ${JSON.stringify(shown)}`);
    }
  }
  return lines;
}
