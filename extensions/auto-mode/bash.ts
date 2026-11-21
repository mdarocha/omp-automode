import { basename } from "node:path";
import {
  parse,
  type ArithmeticExpression,
  type Assignment,
  type Command,
  type ParameterExpansionPart,
  type ParseError,
  type ParsedScript,
  type Redirection,
  type SyntaxNode,
  type TestExpression,
  type Word,
  type WordPart,
} from "../vendor/unbash/dist/parser.js";

export type BashAnalysisError = {
  message: string;
  pos?: number;
};

export type BashRedirectAnalysis = {
  operator: Redirection["operator"];
  target?: string;
  targetDynamic: boolean;
  fileDescriptor?: number;
  variableName?: string;
  heredoc: boolean;
};

/**
 * Returns the path a redirect can open for writing, or undefined when it opens none.
 *
 * Hard-deny path checks only guard writes. Input redirects, heredoc delimiters,
 * here-strings, and fd duplication like `2>&1` never open a path for writing,
 * and treating `1` or `EOF` as a relative file used to hard-deny ordinary
 * commands after any unresolved `cd`. `>&word` still writes a file when the
 * word is not a descriptor number or `-`.
 */
function redirectWriteTarget(
  redirect: BashRedirectAnalysis,
): string | undefined {
  const target = redirect.target;
  if (!target) return undefined;
  switch (redirect.operator) {
    case ">":
    case ">>":
    case ">|":
    case "&>":
    case "&>>":
    case "<>":
      return target;
    case ">&":
      return target === "-" || /^\d+-?$/.test(target) ? undefined : target;
    default:
      return undefined;
  }
}

export type EffectiveCommand = {
  name?: string;
  args: string[];
  argTexts: string[];
  argTildeExpansions: boolean[];
  unresolvedTransparentDispatch: boolean;
};

export type BashCommandAnalysis = {
  raw: string;
  text: string;
  name?: string;
  words: string[];
  args: string[];
  argTexts: string[];
  effectiveCommand: EffectiveCommand;
  redirects: BashRedirectAnalysis[];
  /** Paths this command's redirects can open for writing; see redirectWriteTarget. */
  writeRedirectTargets: string[];
  dynamic: boolean;
  dynamicName: boolean;
  dynamicShellScript: boolean;
  /** True inside a loop or function body, which can run again after later commands. */
  repeated: boolean;
  pos: number;
  end: number;
};

export type BashAnalysis = {
  source: string;
  commands: BashCommandAnalysis[];
  redirects: BashRedirectAnalysis[];
  writeRedirectTargets: string[];
  /**
   * Write targets of redirects that belong to a compound command, a function
   * definition, or a coprocess rather than to one simple command. They are also
   * listed in `writeRedirectTargets`.
   */
  groupWriteRedirectTargets: string[];
  structure: string[];
  allowStructureSafe: boolean;
  errors: BashAnalysisError[];
};

export type BashParser = (source: string) => ParsedScript;

export const MAX_BASH_SOURCE_LENGTH = 1024 * 1024;
const MAX_NESTED_SHELL_DEPTH = 16;

function parseError(error: ParseError): BashAnalysisError {
  return { message: error.message, pos: error.pos };
}

function parserException(error: unknown): BashAnalysisError {
  return {
    message: `Bash parser failed: ${
      error instanceof Error ? error.message : String(error)
    }`,
  };
}

function containsUnquotedBracketExpression(text: string, start: number): boolean {
  let index = start + 1;
  if (text[index] === "!" || text[index] === "^") index += 1;
  let hasMember = false;
  if (text[index] === "]") {
    hasMember = true;
    index += 1;
  }
  let quote: "'" | '"' | "$'" | undefined;
  for (; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (quote === "$'") {
        if (character === "\\") {
          if (index + 1 < text.length) {
            hasMember = true;
            index += 1;
          }
        } else if (character === "'") quote = undefined;
        else hasMember = true;
      } else {
        if (character === quote) quote = undefined;
        else if (quote === '"' && character === "\\") index += 1;
        else hasMember = true;
      }
      continue;
    }
    if (character === "\\") {
      if (index + 1 < text.length) {
        hasMember = true;
        index += 1;
      }
      continue;
    }
    if (character === "$" && text[index + 1] === "'") {
      quote = "$'";
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "]") return hasMember;
    hasMember = true;
  }
  return false;
}

export function hasUnquotedPathnameExpansion(text: string): boolean {
  let quote: "'" | '"' | "$'" | undefined;
  for (let index = 0; index < text.length; index += 1) {
    const character = text[index];
    if (quote) {
      if (quote === "$'") {
        if (character === "\\") index += 1;
        else if (character === "'") quote = undefined;
      } else {
        if (character === quote) quote = undefined;
        else if (quote === '"' && character === "\\") index += 1;
      }
      continue;
    }
    if (character === "\\") {
      index += 1;
      continue;
    }
    if (character === "$" && text[index + 1] === "'") {
      quote = "$'";
      index += 1;
      continue;
    }
    if (character === "'" || character === '"') {
      quote = character;
      continue;
    }
    if (character === "*" || character === "?") return true;
    if (
      character === "[" &&
      containsUnquotedBracketExpression(text, index)
    ) {
      return true;
    }
  }
  return false;
}

function wordParts(word: Word): readonly WordPart[] {
  return word.parts ?? [];
}

/** Syntax nodes that hold commands or redirects, which the walker visits. */
type StructureNode = Extract<
  SyntaxNode,
  {
    type:
      | "Command"
      | "Pipeline"
      | "AndOr"
      | "If"
      | "For"
      | "ArithmeticFor"
      | "Select"
      | "While"
      | "Function"
      | "Subshell"
      | "BraceGroup"
      | "CompoundList"
      | "Case"
      | "Coproc"
      | "TestCommand"
      | "ArithmeticCommand"
      | "Statement"
      | "Redirected";
  }
>;

/** An assignment-looking argument (`export A=b`) as a word, like unbash 4 produced. */
export function argumentWord(argument: Word | Assignment): Word {
  if (argument.type === "Word") return argument;
  const parts: WordPart[] = [...(argument.index?.parts ?? [])];
  const value = argument.value;
  for (const word of value.type === "Word" ? [value] : value.elements) {
    parts.push(...(word.parts ?? []));
  }
  return {
    type: "Word",
    pos: argument.pos,
    end: argument.end,
    text: argument.text,
    value: value.type === "Word"
      ? argument.text.slice(0, argument.text.length - value.text.length) +
        value.value
      : argument.text,
    parts,
  };
}

function commandAssignments(command: Command): Assignment[] {
  return command.prefix.filter(
    (item): item is Assignment => item.type === "Assignment",
  );
}

function redirectDescriptor(redirect: Redirection): {
  fileDescriptor?: number;
  variableName?: string;
} {
  const descriptor = redirect.descriptor;
  if (!descriptor) return {};
  return descriptor.type === "FileDescriptor"
    ? { fileDescriptor: descriptor.value }
    : { variableName: descriptor.name };
}

function isTerminatedSubstitution(text: string): boolean {
  return text.startsWith("`") ? text.length > 1 && text.endsWith("`") : text.endsWith(")");
}

const ANSI_C_ESCAPE =
  /\\(?:([0-7]{1,3})|x([0-9a-fA-F]{1,2})|u([0-9a-fA-F]{1,4})|U([0-9a-fA-F]{1,8})|c([\s\S])|[\s\S])/g;

/**
 * Whether an ANSI-C quoted word (`$'…'`) contains an escape for NUL. Bash cuts
 * the string at a NUL, and unbash 6 does too, so the parsed value no longer
 * shows it; the escape is still a sign of an attempt to hide the text after it.
 */
function ansiCDecodesToNul(text: string): boolean {
  for (const [, octal, hex, short, long, control] of text.matchAll(ANSI_C_ESCAPE)) {
    if (octal !== undefined && (Number.parseInt(octal, 8) & 0xff) === 0) return true;
    if (hex !== undefined && Number.parseInt(hex, 16) === 0) return true;
    if (short !== undefined && Number.parseInt(short, 16) === 0) return true;
    if (long !== undefined && Number.parseInt(long, 16) === 0) return true;
    if (control !== undefined && (control.charCodeAt(0) & 0x1f) === 0) return true;
  }
  return false;
}

function wordIsStatic(word: Word): boolean {
  const parts = wordParts(word);
  if (parts.length === 0) return true;
  return parts.every(partIsStatic);
}

function wordHasTildeExpansion(word: Word): boolean {
  if (!word.text.startsWith("~")) return false;
  for (const character of word.text.slice(1)) {
    if (character === "/") return true;
    if (["\\", "'", '"', "$", "`"].includes(character)) return false;
  }
  return true;
}

function partIsStatic(part: WordPart): boolean {
  switch (part.type) {
    case "Literal":
    case "SingleQuoted":
    case "AnsiCQuoted":
      return true;
    case "Glob":
      return (part.parts ?? []).every(partIsStatic);
    case "DoubleQuoted":
      return part.parts.every((child) => child.type === "Literal");
    case "LocaleString":
    case "SimpleExpansion":
    case "ParameterExpansion":
    case "CommandExpansion":
    case "ArithmeticExpansion":
    case "ProcessSubstitution":
    case "ExtendedGlob":
    case "BraceExpansion":
      return false;
  }
}

function commandName(value: string | undefined): string | undefined {
  if (!value) return undefined;
  return basename(value).toLowerCase();
}

type CommandInvocation = {
  name?: string;
  argumentWords: Word[];
  unresolvedTransparentDispatch: boolean;
  pathnameExpandedExecutable?: Word;
};

function unwrapTransparentCommandOnce(
  name: string | undefined,
  argumentWords: Word[],
): CommandInvocation {
  if (
    name !== "command" && name !== "exec" && name !== "env" &&
    name !== "builtin"
  ) {
    return { name, argumentWords, unresolvedTransparentDispatch: false };
  }

  let index = 0;
  let optionsEnded = false;
  while (index < argumentWords.length) {
    const word = argumentWords[index];
    if (!word || !wordIsStatic(word)) {
      return {
        argumentWords: [],
        unresolvedTransparentDispatch: true,
      };
    }
    const value = word.value;
    if (!optionsEnded && value === "--") {
      optionsEnded = true;
      index += 1;
      continue;
    }

    if (name === "builtin" && !optionsEnded && value.startsWith("-")) {
      return { argumentWords: [], unresolvedTransparentDispatch: true };
    }

    if (name === "command" && !optionsEnded) {
      if (value === "-p") {
        index += 1;
        continue;
      }
      if (value === "-v" || value === "-V" || value.startsWith("-")) {
        return { argumentWords: [], unresolvedTransparentDispatch: true };
      }
    }

    if (name === "exec" && !optionsEnded) {
      if (value === "-a") {
        const optionValue = argumentWords[index + 1];
        if (!optionValue || !wordIsStatic(optionValue)) {
          return { argumentWords: [], unresolvedTransparentDispatch: true };
        }
        index += 2;
        continue;
      }
      if (/^-[cl]+$/.test(value)) {
        index += 1;
        continue;
      }
      if (value.startsWith("-")) {
        return { argumentWords: [], unresolvedTransparentDispatch: true };
      }
    }

    if (name === "env") {
      if (!optionsEnded && value.startsWith("-")) {
        if (
          value === "-i" ||
          value === "--ignore-environment" ||
          value === "-0" ||
          value === "--null" ||
          value === "-v" ||
          value === "--debug"
        ) {
          index += 1;
          continue;
        }
        if (["-u", "--unset", "-C", "--chdir"].includes(value)) {
          const optionValue = argumentWords[index + 1];
          if (!optionValue || !wordIsStatic(optionValue)) {
            return { argumentWords: [], unresolvedTransparentDispatch: true };
          }
          index += 2;
          continue;
        }
        if (value.startsWith("--unset=") || value.startsWith("--chdir=")) {
          index += 1;
          continue;
        }
        return { argumentWords: [], unresolvedTransparentDispatch: true };
      }
      if (/^[^=]+=/.test(value)) {
        index += 1;
        continue;
      }
    }

    if (hasUnquotedPathnameExpansion(word.text)) {
      return {
        argumentWords: [],
        unresolvedTransparentDispatch: true,
        pathnameExpandedExecutable: word,
      };
    }

    return {
      name: commandName(value),
      argumentWords: argumentWords.slice(index + 1),
      unresolvedTransparentDispatch: false,
    };
  }

  return { argumentWords: [], unresolvedTransparentDispatch: true };
}

function effectiveCommandInvocation(
  name: string | undefined,
  argumentWords: Word[],
): CommandInvocation {
  let invocation: CommandInvocation = {
    name,
    argumentWords,
    unresolvedTransparentDispatch: false,
  };
  for (let depth = 0; depth < MAX_NESTED_SHELL_DEPTH; depth += 1) {
    const next = unwrapTransparentCommandOnce(
      invocation.name,
      invocation.argumentWords,
    );
    if (next.unresolvedTransparentDispatch) return next;
    if (
      next.name === invocation.name &&
      next.argumentWords === invocation.argumentWords
    ) {
      return next;
    }
    invocation = next;
  }
  return { argumentWords: [], unresolvedTransparentDispatch: true };
}

type NestedShell = {
  name?: string;
  source?: string;
  hasScriptArgument: boolean;
};

function nestedShell(invocation: CommandInvocation): NestedShell | undefined {
  if (invocation.unresolvedTransparentDispatch) {
    return { hasScriptArgument: true };
  }
  if (invocation.name === "eval") {
    return {
      name: "eval",
      source:
        invocation.argumentWords.length > 0 &&
          invocation.argumentWords.every(wordIsStatic)
        ? invocation.argumentWords.map((word) => word.value).join(" ")
        : undefined,
      hasScriptArgument: invocation.argumentWords.length > 0,
    };
  }
  if (invocation.name !== "bash" && invocation.name !== "sh") {
    return undefined;
  }
  const commandOptionIndex = invocation.argumentWords.findIndex((word) =>
    /^-[^-]*c/.test(word.value)
  );
  if (commandOptionIndex < 0) return undefined;
  const scriptWord = invocation.argumentWords[commandOptionIndex + 1];
  return {
    name: invocation.name,
    source: scriptWord && wordIsStatic(scriptWord) ? scriptWord.value : undefined,
    hasScriptArgument: true,
  };
}

function exhaustiveNode(_node: never): never {
  throw new Error(`Unsupported unbash AST node: ${JSON.stringify(_node)}`);
}

const REPEATED_NODE_TYPES: Partial<Record<StructureNode["type"], true>> = {
  While: true,
  For: true,
  Select: true,
  ArithmeticFor: true,
  Function: true,
};

/** Analyze Bash tool input or permission-pattern text without executing it. */
export function analyzeBash(
  source: string,
  parser: BashParser = parse,
  sourceKind: "command" | "permission-pattern" = "command",
): BashAnalysis {
  const analysis: BashAnalysis = {
    source,
    commands: [],
    redirects: [],
    writeRedirectTargets: [],
    groupWriteRedirectTargets: [],
    structure: [],
    allowStructureSafe: true,
    errors: [],
  };
  if (source.length > MAX_BASH_SOURCE_LENGTH) {
    analysis.errors.push({
      message:
        `Bash input length ${source.length} exceeds ${MAX_BASH_SOURCE_LENGTH}`,
    });
    return analysis;
  }

  function analyzeRedirect(redirect: Redirection): BashRedirectAnalysis {
    // A here-document's "target" is its delimiter, which is not a word to expand.
    const target = redirect.type === "HereDoc"
      ? redirect.delimiter
      : redirect.target;
    return {
      operator: redirect.operator,
      target: target?.value,
      targetDynamic: redirect.type === "HereDoc"
        ? /[$`]/.test(redirect.delimiter?.text ?? "")
        : !!redirect.target && !wordIsStatic(redirect.target),
      ...redirectDescriptor(redirect),
      heredoc: redirect.type === "HereDoc",
    };
  }

  function visitRedirect(
    redirect: Redirection,
    currentSource: string,
    depth: number,
    group = false,
  ): string | undefined {
    const redirectAnalysis = analyzeRedirect(redirect);
    analysis.redirects.push(redirectAnalysis);
    analysis.structure.push(
      `redirect:${redirectAnalysis.fileDescriptor ?? ""}:${redirectAnalysis.variableName ?? ""}:${redirect.operator}:${redirectAnalysis.heredoc ? "heredoc" : "file"}`,
    );
    if (redirect.type === "HereDoc") {
      if (redirect.body.text.includes("\0")) {
        analysis.errors.push({
          message: "Decoded NUL in a Bash word is unsupported",
          pos: redirect.body.pos,
        });
      } else {
        for (const part of redirect.body.parts ?? []) {
          visitPart(part, currentSource, depth);
        }
      }
    } else if (redirect.target) {
      visitWord(redirect.target, currentSource, depth);
    }
    const target = redirectAnalysis.target;
    const writeTarget = redirectWriteTarget(redirectAnalysis);
    if (writeTarget) {
      analysis.writeRedirectTargets.push(writeTarget);
      if (group) analysis.groupWriteRedirectTargets.push(writeTarget);
    }
    return target;
  }

  function visitParameterOperation(
    part: ParameterExpansionPart,
    currentSource: string,
    depth: number,
  ): void {
    const operation = part.operation;
    switch (operation?.type) {
      case undefined:
      case "Names":
        return;
      case "Default":
      case "Remove":
      case "Transform":
        visitWord(operation.operand, currentSource, depth);
        return;
      case "CaseModification":
        if (operation.operand) visitWord(operation.operand, currentSource, depth);
        return;
      case "Replace":
        visitWord(operation.pattern, currentSource, depth);
        visitWord(operation.replacement, currentSource, depth);
        return;
      case "Slice":
        visitWord(operation.offset, currentSource, depth);
        if (operation.length) visitWord(operation.length, currentSource, depth);
        return;
      case "Unknown":
        // The parser kept no operand, so its content cannot be checked.
        analysis.errors.push({
          message: `Unsupported parameter expansion operator: ${operation.operator}`,
          pos: part.pos,
        });
        return;
    }
  }

  function visitPart(
    part: WordPart,
    currentSource: string,
    depth: number,
  ): void {
    switch (part.type) {
      case "Literal":
      case "SingleQuoted":
      case "AnsiCQuoted":
        if (
          part.value.includes("\0") ||
          (part.type === "AnsiCQuoted" && ansiCDecodesToNul(part.text))
        ) {
          analysis.errors.push({
            message: "Decoded NUL in a Bash word part is unsupported",
          });
        }
        return;
      case "SimpleExpansion":
        return;
      case "DoubleQuoted":
      case "LocaleString":
        for (const child of part.parts) visitPart(child, currentSource, depth);
        return;
      case "ParameterExpansion":
        if (part.index) visitWord(part.index, currentSource, depth);
        visitParameterOperation(part, currentSource, depth);
        return;
      case "CommandExpansion":
      case "ProcessSubstitution":
        analysis.structure.push(
          `part:${part.type}:${part.type === "ProcessSubstitution" ? part.operator : ""}`,
        );
        // unbash cuts the pattern of `${x/$(a /b)/y}` at the slash inside the
        // substitution, so the command it parsed is not the one bash runs.
        if (!isTerminatedSubstitution(part.text)) {
          analysis.errors.push({
            message: "Unterminated command substitution in a Bash word is unsupported",
            pos: part.pos,
          });
        }
        if (part.script) {
          visitScript(part.script, part.script.source ?? currentSource, depth);
        }
        return;
      case "ArithmeticExpansion":
        if (part.expression) {
          visitArithmetic(part.expression, currentSource, depth);
        }
        return;
      case "Glob":
        for (const nestedPart of part.parts ?? []) {
          visitPart(nestedPart, currentSource, depth);
        }
        return;
      case "ExtendedGlob":
      case "BraceExpansion":
        for (const nestedPart of part.parts ?? []) {
          visitPart(nestedPart, currentSource, depth);
        }
        return;
    }
  }

  function visitWord(word: Word, currentSource: string, depth: number): void {
    if (word.value.includes("\0")) {
      analysis.errors.push({
        message: "Decoded NUL in a Bash word is unsupported",
        pos: word.pos,
      });
      return;
    }
    for (const part of wordParts(word)) {
      visitPart(part, currentSource, depth);
    }
  }

  function visitArithmetic(
    expression: ArithmeticExpression,
    currentSource: string,
    depth: number,
  ): void {
    switch (expression.type) {
      case "ArithmeticBinary":
        visitArithmetic(expression.left, currentSource, depth);
        visitArithmetic(expression.right, currentSource, depth);
        return;
      case "ArithmeticUnary":
        visitArithmetic(expression.operand, currentSource, depth);
        return;
      case "ArithmeticTernary":
        visitArithmetic(expression.test, currentSource, depth);
        visitArithmetic(expression.consequent, currentSource, depth);
        visitArithmetic(expression.alternate, currentSource, depth);
        return;
      case "ArithmeticGroup":
        visitArithmetic(expression.expression, currentSource, depth);
        return;
      case "ArithmeticWord":
        for (const part of expression.parts ?? []) {
          visitPart(part, currentSource, depth);
        }
        return;
      case "ArithmeticCommandExpansion":
        analysis.structure.push("part:ArithmeticCommandExpansion");
        if (expression.script) {
          visitScript(
            expression.script,
            expression.script.source ?? currentSource,
            depth,
          );
        }
        return;
    }
  }

  function visitTest(
    expression: TestExpression,
    currentSource: string,
    depth: number,
  ): void {
    switch (expression.type) {
      case "TestUnary":
        visitWord(expression.operand, currentSource, depth);
        return;
      case "TestBinary":
        visitWord(expression.left, currentSource, depth);
        visitWord(expression.right, currentSource, depth);
        return;
      case "TestLogical":
        for (const operand of expression.operands) {
          visitTest(operand, currentSource, depth);
        }
        return;
      case "TestNot":
        visitTest(expression.operand, currentSource, depth);
        return;
      case "TestGroup":
        visitTest(expression.expression, currentSource, depth);
        return;
    }
  }

  /** Structure token of a node, or undefined for one that adds none. */
  function nodeStructureToken(node: StructureNode): string | undefined {
    switch (node.type) {
      case "Command":
        return `node:Command:${commandAssignments(node).length}:${node.redirects.length}`;
      case "Pipeline":
        return `node:Pipeline:${node.prefixes.some((prefix) => prefix.type === "Negation") ? "negated" : "plain"}:${node.prefixes.some((prefix) => prefix.type === "Time") ? "time" : "plain"}:${node.operators.join(",")}`;
      case "AndOr":
        return `node:AndOr:${node.operators.join(",")}`;
      case "If":
        return `node:If:${node.elif.length > 0 ? "If" : (node.else?.type ?? "none")}`;
      case "For":
      case "Select":
        return `node:${node.type}:${node.wordlist?.length ?? 0}`;
      case "ArithmeticFor":
        return `node:ArithmeticFor:${node.initialize ? 1 : 0}:${node.test ? 1 : 0}:${node.update ? 1 : 0}`;
      case "While":
        return `node:While:${node.kind}`;
      case "Function":
        return `node:Function:${node.body.type === "Redirected" ? node.body.redirects.length : 0}`;
      case "Subshell":
      case "BraceGroup":
      case "TestCommand":
      case "ArithmeticCommand":
        return `node:${node.type}`;
      case "CompoundList":
        return `node:CompoundList:${node.commands.length}`;
      case "Case":
        return `node:Case:${node.items.map((item) => item.terminator ?? "none").join(",")}`;
      case "Coproc":
        return `node:Coproc:${node.body.type === "Redirected" ? node.body.redirects.length : 0}`;
      case "Statement":
        return `node:Statement:${node.background ? "background" : "foreground"}:${node.command.type === "Redirected" ? node.command.redirects.length : 0}`;
      case "Redirected":
        return undefined;
      default:
        return exhaustiveNode(node);
    }
  }

  // Loop and function bodies can run again after later commands, so commands
  // inside them cannot assume an earlier position in the script.
  let repeatedDepth = 0;

  function visitNode(node: StructureNode, nodeSource: string, depth: number): void {
    if (!REPEATED_NODE_TYPES[node.type]) {
      visitNodeContents(node, nodeSource, depth);
      return;
    }
    repeatedDepth += 1;
    try {
      visitNodeContents(node, nodeSource, depth);
    } finally {
      repeatedDepth -= 1;
    }
  }

  function visitNodeContents(
    node: StructureNode,
    nodeSource: string,
    depth: number,
  ): void {
    const token = nodeStructureToken(node);
    if (token !== undefined) analysis.structure.push(token);
    if (
      node.type === "For" ||
      node.type === "Select" ||
      node.type === "ArithmeticFor" ||
      node.type === "Function" ||
      node.type === "Case" ||
      node.type === "Coproc" ||
      node.type === "TestCommand" ||
      node.type === "ArithmeticCommand"
    ) {
      analysis.allowStructureSafe = false;
    }
    switch (node.type) {
      case "Command": {
        const assignments = commandAssignments(node);
        const argumentWords = node.args.map(argumentWord);
        const prefixWords = assignments.map((assignment) => assignment.text);
        const commandWords = node.name
          ? [node.name, ...argumentWords]
          : argumentWords;
        const renderedWords = [
          ...prefixWords,
          ...commandWords.map((word) => word.text),
        ];
        const values = [
          ...prefixWords,
          ...commandWords.map((word) => word.value),
        ];
        const redirects = node.redirects.map(analyzeRedirect);
        const writeRedirectTargets = redirects
          .map(redirectWriteTarget)
          .filter((target): target is string => !!target);
        const pathnameExpandedName = node.name &&
          hasUnquotedPathnameExpansion(node.name.text) ? node.name : undefined;
        const normalizedName = pathnameExpandedName
          ? undefined
          : commandName(node.name?.value);
        const invocation: CommandInvocation = pathnameExpandedName
          ? {
            argumentWords: [],
            unresolvedTransparentDispatch: true,
            pathnameExpandedExecutable: pathnameExpandedName,
          }
          : effectiveCommandInvocation(normalizedName, argumentWords);
        if (
          invocation.pathnameExpandedExecutable &&
          sourceKind === "command"
        ) {
          analysis.errors.push({
            message:
              "Executable pathname expansion cannot be resolved for deterministic safety checks; name the executable literally, resolving the glob in a separate call first",
            pos: invocation.pathnameExpandedExecutable.pos,
          });
        }
        const wrapper = nestedShell(invocation);
        const wrapperSource = wrapper?.source;
        analysis.commands.push({
          raw: nodeSource.slice(node.pos, node.end),
          text: renderedWords.join(" "),
          name: normalizedName,
          words: values,
          args: argumentWords.map((word) => word.value),
          argTexts: argumentWords.map((word) => word.text),
          effectiveCommand: {
            name: invocation.name,
            args: invocation.argumentWords.map((word) => word.value),
            argTexts: invocation.argumentWords.map((word) => word.text),
            argTildeExpansions:
              invocation.argumentWords.map(wordHasTildeExpansion),
            unresolvedTransparentDispatch:
              invocation.unresolvedTransparentDispatch,
          },
          redirects,
          writeRedirectTargets,
          dynamic: !!pathnameExpandedName ||
            commandWords.some((word) => !wordIsStatic(word)),
          dynamicName: !!pathnameExpandedName ||
            (!!node.name && !wordIsStatic(node.name)),
          dynamicShellScript:
            !!wrapper?.hasScriptArgument && wrapperSource === undefined,
          repeated: repeatedDepth > 0,
          pos: node.pos,
          end: node.end,
        });

        for (const redirect of node.redirects) {
          visitRedirect(redirect, nodeSource, depth);
        }
        if (node.name) visitWord(node.name, nodeSource, depth);
        for (const assignment of assignments) {
          for (
            const word of assignment.value.type === "Word"
              ? [assignment.value]
              : assignment.value.elements
          ) {
            visitWord(word, nodeSource, depth);
          }
          if (assignment.index) visitWord(assignment.index, nodeSource, depth);
        }
        for (const word of argumentWords) visitWord(word, nodeSource, depth);

        if (wrapperSource !== undefined) {
          analysis.structure.push(`wrapper:${wrapper?.name ?? normalizedName}`);
          if (depth >= MAX_NESTED_SHELL_DEPTH) {
            analysis.errors.push({
              message: `Nested shell depth exceeds ${MAX_NESTED_SHELL_DEPTH}`,
            });
          } else {
            try {
              visitScript(parser(wrapperSource), wrapperSource, depth + 1);
            } catch (error) {
              analysis.errors.push(parserException(error));
            }
          }
        }
        return;
      }
      case "Pipeline":
      case "AndOr":
        for (const command of node.commands) visitNode(command, nodeSource, depth);
        return;
      case "If":
        visitNode(node.clause, nodeSource, depth);
        visitNode(node.then, nodeSource, depth);
        for (const [index, elif] of node.elif.entries()) {
          // An `elif` is a nested `if` in unbash 4; keep its structure token.
          analysis.structure.push(
            `node:If:${index + 1 < node.elif.length ? "If" : (node.else?.type ?? "none")}`,
          );
          visitNode(elif.clause, nodeSource, depth);
          visitNode(elif.then, nodeSource, depth);
        }
        if (node.else) visitNode(node.else, nodeSource, depth);
        return;
      case "For":
      case "Select":
        visitWord(node.name, nodeSource, depth);
        for (const word of node.wordlist ?? []) {
          visitWord(word, nodeSource, depth);
        }
        visitNode(node.body, nodeSource, depth);
        return;
      case "ArithmeticFor":
        if (node.initialize) visitArithmetic(node.initialize, nodeSource, depth);
        if (node.test) visitArithmetic(node.test, nodeSource, depth);
        if (node.update) visitArithmetic(node.update, nodeSource, depth);
        visitNode(node.body, nodeSource, depth);
        return;
      case "While":
        visitNode(node.clause, nodeSource, depth);
        visitNode(node.body, nodeSource, depth);
        return;
      case "Function":
        visitWord(node.name, nodeSource, depth);
        visitNode(node.body, nodeSource, depth);
        return;
      case "Subshell":
      case "BraceGroup":
        visitNode(node.body, nodeSource, depth);
        return;
      case "CompoundList":
        for (const statement of node.commands) {
          visitNode(statement, nodeSource, depth);
        }
        return;
      case "Case":
        visitWord(node.word, nodeSource, depth);
        for (const item of node.items) {
          for (const pattern of item.pattern) {
            visitWord(pattern, nodeSource, depth);
          }
          visitNode(item.body, nodeSource, depth);
        }
        return;
      case "Coproc":
        if (node.name) visitWord(node.name, nodeSource, depth);
        visitNode(node.body, nodeSource, depth);
        return;
      case "TestCommand":
        visitTest(node.expression, nodeSource, depth);
        return;
      case "ArithmeticCommand":
        if (node.expression) {
          visitArithmetic(node.expression, nodeSource, depth);
        }
        return;
      case "Statement":
        visitNode(node.command, nodeSource, depth);
        return;
      case "Redirected":
        for (const redirect of node.redirects) {
          visitRedirect(redirect, nodeSource, depth, true);
        }
        visitNode(node.command, nodeSource, depth);
        return;
      default:
        exhaustiveNode(node);
    }
  }

  function visitScript(
    script: ParsedScript,
    scriptSource: string,
    depth: number,
  ): void {
    analysis.structure.push(`script:${script.commands.length}`);
    for (const error of script.errors ?? []) analysis.errors.push(parseError(error));
    for (const statement of script.commands) {
      visitNode(statement, scriptSource, depth);
    }
  }

  try {
    visitScript(parser(source), source, 0);
  } catch (error) {
    analysis.errors.push(parserException(error));
  }

  return analysis;
}

const SINGLE_SIMPLE_COMMAND_STRUCTURE = [
  "script:1",
  "node:Statement:foreground:0",
  "node:Command:0:0",
];

/**
 * Returns the command name when the whole script is one plain foreground
 * command: no environment prefix, wrapper, redirect, pipeline, list,
 * subshell, command substitution, or background job.
 */
export function singleSimpleCommandName(
  analysis: BashAnalysis,
): string | undefined {
  if (analysis.errors.length > 0 || analysis.commands.length !== 1) {
    return undefined;
  }
  const structure = analysis.structure;
  if (
    structure.length !== SINGLE_SIMPLE_COMMAND_STRUCTURE.length ||
    structure.some((entry, i) => entry !== SINGLE_SIMPLE_COMMAND_STRUCTURE[i])
  ) {
    return undefined;
  }
  const command = analysis.commands[0];
  if (command.dynamicName || command.name !== command.words[0]) {
    return undefined;
  }
  return command.name;
}

/** Literal command names the script can run, including wrapped ones (`command lsp`). */
export function literalCommandNames(analysis: BashAnalysis): Set<string> {
  const names = new Set<string>();
  for (const command of analysis.commands) {
    if (command.dynamicName) {
      continue;
    }
    for (const name of [command.name, command.effectiveCommand.name]) {
      if (name !== undefined) {
        names.add(name);
      }
    }
  }
  return names;
}
