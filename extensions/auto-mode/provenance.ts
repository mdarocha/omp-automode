import { lstatSync } from "node:fs";
import { basename, dirname, isAbsolute, resolve, sep } from "node:path";
import { type BashAnalysis, hasUnquotedPathnameExpansion } from "./bash.ts";
import { HOME } from "./constants.ts";
import { resolveToolInputPath } from "./paths.ts";

/** Most created paths kept in the session state, newest last. */
export const CREATED_PATHS_LIMIT = 100;
/** Most created paths shown to the classifier, newest last. */
export const CLASSIFIER_CREATED_PATHS_LIMIT = 30;
/** Creating calls that were allowed but have not reported a result yet. */
export const MAX_PENDING_CREATIONS = 64;
export const SESSION_CREATED_PATHS_TAG = "session-created-paths";

const MAX_CREATED_PATH_LENGTH = 512;
// Control characters and angle brackets would let a crafted directory name
// close the classifier block or add lines to it.
const UNSAFE_PATH_CHARACTERS = /[\u0000-\u001f\u007f<>]/;
const URL_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i;
/** Cheap pre-filter: skip parsing bash that cannot contain a tracked creator. */
const CREATOR_COMMAND_HINT = /\b(?:mkdir|mktemp|clone|worktree)\b/;
// Filesystem timestamps can trail Date.now() by a few milliseconds.
const CTIME_SLACK_MS = 2000;
const DEFAULT_MKTEMP_TEMPLATE = "tmp.XXXXXXXXXX";
const MKTEMP_RANDOM_CHARACTERS = "[A-Za-z0-9]";
/**
 * Structure that keeps `cd` order-sound: plain sequences and `&&` chains.
 * Branches, loops, subshells, substitutions, pipelines, background jobs, and
 * nested shells can run a `cd` conditionally or in another process.
 */
const CWD_TRACKABLE_STRUCTURE =
  /^(?:script:\d+|node:Statement:foreground:\d+|node:AndOr:&&(?:,&&)*|node:Command:\d+:\d+|redirect:.*)$/;
// Builtins that can change the working directory in ways this module cannot follow.
const UNFOLLOWABLE_CWD_COMMANDS: readonly string[] = ["pushd", "popd", "source", "."];
const CD_OPTIONS: readonly string[] = ["-L", "-P", "-e", "-@", "--"];

/** A path an allowed call is expected to create. */
export type PathClaim = {
  path: string;
  /** True when the command also creates every missing leading directory. */
  createsParents: boolean;
};

/** A `mktemp` whose path is only known from the call's output. */
export type MktempClaim = {
  /** Working directory at the command; undefined when it could not be followed. */
  cwd: string | undefined;
  /** Shape of the random file name the template produces. */
  basename: RegExp;
};

export type CreationClaims = {
  paths: PathClaim[];
  mktemp?: MktempClaim;
};

/** A creating call that was allowed, with what existed when it started. */
export type PendingCreation = {
  /** Topmost paths that did not exist before the call. */
  paths: string[];
  mktemp?: MktempClaim;
  startedAtMs: number;
};

type Argument = { value: string; text: string };

type OptionSpec = {
  shortFlags: string;
  shortValued: string;
  longFlags: readonly string[];
  longValued: readonly string[];
};

type ParsedArguments = {
  operands: Argument[];
  flags: Set<string>;
  values: Map<string, string>;
};

const MKDIR_OPTIONS: OptionSpec = {
  shortFlags: "pvZ",
  shortValued: "m",
  longFlags: ["--parents", "--verbose", "--context"],
  longValued: ["--mode"],
};

const MKTEMP_OPTIONS: OptionSpec = {
  shortFlags: "dqtu",
  shortValued: "p",
  longFlags: ["--directory", "--quiet", "--dry-run", "--tmpdir"],
  longValued: ["--suffix"],
};

const GIT_CLONE_OPTIONS: OptionSpec = {
  shortFlags: "nqvls46",
  shortValued: "obucj",
  longFlags: [
    "--bare",
    "--mirror",
    "--checkout",
    "--no-checkout",
    "--quiet",
    "--verbose",
    "--progress",
    "--recursive",
    "--recurse-submodules",
    "--single-branch",
    "--no-single-branch",
    "--tags",
    "--no-tags",
    "--shallow-submodules",
    "--no-shallow-submodules",
    "--local",
    "--no-local",
    "--shared",
    "--no-hardlinks",
    "--sparse",
    "--dissociate",
    "--also-filter-submodules",
    "--remote-submodules",
    "--no-remote-submodules",
    "--reject-shallow",
    "--no-reject-shallow",
  ],
  longValued: [
    "--branch",
    "--origin",
    "--depth",
    "--jobs",
    "--reference",
    "--reference-if-able",
    "--separate-git-dir",
    "--template",
    "--upload-pack",
    "--config",
    "--filter",
    "--shallow-since",
    "--shallow-exclude",
    "--bundle-uri",
    "--ref-format",
    "--server-option",
    "--revision",
  ],
};

const GH_CLONE_OPTIONS: OptionSpec = {
  shortFlags: "",
  shortValued: "u",
  longFlags: [],
  longValued: ["--upstream-remote-name"],
};

const GIT_WORKTREE_ADD_OPTIONS: OptionSpec = {
  shortFlags: "fq",
  shortValued: "bB",
  longFlags: [
    "--force",
    "--detach",
    "--checkout",
    "--no-checkout",
    "--lock",
    "--orphan",
    "--quiet",
    "--track",
    "--no-track",
    "--guess-remote",
    "--no-guess-remote",
    "--relative-paths",
    "--no-relative-paths",
  ],
  longValued: ["--reason"],
};

/** Split command arguments into operands, flags, and option values; undefined on any unknown option. */
function parseArguments(
  args: readonly Argument[],
  spec: OptionSpec,
): ParsedArguments | undefined {
  const parsed: ParsedArguments = { operands: [], flags: new Set(), values: new Map() };
  let optionsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) continue;
    const value = arg.value;
    if (optionsEnded || value === "-" || !value.startsWith("-")) {
      parsed.operands.push(arg);
      continue;
    }
    if (value === "--") {
      optionsEnded = true;
      continue;
    }
    if (value.startsWith("--")) {
      const equals = value.indexOf("=");
      const name = equals < 0 ? value : value.slice(0, equals);
      if (spec.longValued.includes(name)) {
        let optionValue = equals < 0 ? undefined : value.slice(equals + 1);
        if (optionValue === undefined) {
          index += 1;
          optionValue = args[index]?.value;
          if (optionValue === undefined) return undefined;
        }
        parsed.flags.add(name);
        parsed.values.set(name, optionValue);
        continue;
      }
      if (!spec.longFlags.includes(name)) return undefined;
      parsed.flags.add(name);
      continue;
    }
    for (let position = 1; position < value.length; position += 1) {
      const letter = value[position] ?? "";
      if (spec.shortValued.includes(letter)) {
        let optionValue = value.slice(position + 1);
        if (optionValue === "") {
          index += 1;
          optionValue = args[index]?.value ?? "";
          if (args[index] === undefined) return undefined;
        }
        parsed.flags.add(`-${letter}`);
        parsed.values.set(`-${letter}`, optionValue);
        break;
      }
      if (!spec.shortFlags.includes(letter)) return undefined;
      parsed.flags.add(`-${letter}`);
    }
  }
  return parsed;
}

function pathExists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    // An unreadable path may exist, so only a definite absence counts as missing.
    return code !== "ENOENT" && code !== "ENOTDIR";
  }
}

/** The first missing component below the deepest existing ancestor, or undefined when `path` exists. */
function topmostMissingPath(path: string): string | undefined {
  if (pathExists(path)) return undefined;
  let top = path;
  for (;;) {
    const parent = dirname(top);
    if (parent === top || pathExists(parent)) return top;
    top = parent;
  }
}

/** Resolve one shell operand to an absolute path; undefined when the shell result is unknowable here. */
function resolveOperand(
  base: string | undefined,
  operand: Argument,
): string | undefined {
  const { value, text } = operand;
  if (value === "" || hasUnquotedPathnameExpansion(text)) return undefined;
  if (text.startsWith("~")) {
    if (value === "~") return HOME;
    return value.startsWith("~/") ? resolve(HOME, value.slice(2)) : undefined;
  }
  if (isAbsolute(value)) return resolve(value);
  return base === undefined ? undefined : resolve(base, value);
}

/** The directory `git clone` and `gh repo clone` pick when none is given. */
function defaultCloneDirectory(repository: string, bare: boolean): string | undefined {
  const stripped = repository.replace(/[\\/]+$/, "").replace(/[\\/]\.git$/, "").replace(/\.git$/, "");
  const name = stripped.slice(Math.max(stripped.lastIndexOf("/"), stripped.lastIndexOf("\\"), stripped.lastIndexOf(":")) + 1);
  if (name === "" || name === "." || name === "..") return undefined;
  return bare ? `${name}.git` : name;
}

function cdTarget(args: readonly Argument[], base: string | undefined): string | undefined {
  const operands = args.filter((arg) => !CD_OPTIONS.includes(arg.value));
  if (operands.length === 0) return HOME;
  const [target] = operands;
  if (operands.length > 1 || !target || target.value === "-") return undefined;
  return resolveOperand(base, target);
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function mktempClaim(args: readonly Argument[], cwd: string | undefined): MktempClaim | undefined {
  const parsed = parseArguments(args, MKTEMP_OPTIONS);
  if (!parsed || parsed.operands.length > 1) return undefined;
  if (parsed.flags.has("-u") || parsed.flags.has("--dry-run")) return undefined;
  const name = basename(parsed.operands[0]?.value ?? DEFAULT_MKTEMP_TEMPLATE);
  const lastRun = [...name.matchAll(/X{3,}/g)].at(-1);
  if (!lastRun) return undefined;
  const prefix = name.slice(0, lastRun.index);
  const suffix = name.slice(lastRun.index + lastRun[0].length) + (parsed.values.get("--suffix") ?? "");
  return {
    cwd,
    basename: new RegExp(
      `^${escapeRegExp(prefix)}${MKTEMP_RANDOM_CHARACTERS}{${lastRun[0].length}}${escapeRegExp(suffix)}$`,
    ),
  };
}

type GitInvocation = { base: string | undefined; subcommand: string; rest: Argument[] };

/** Split `git [-C dir] [-c k=v] <subcommand> ...`; undefined for any other global option. */
function parseGitInvocation(args: readonly Argument[], cwd: string | undefined): GitInvocation | undefined {
  let base = cwd;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg) return undefined;
    if (arg.value === "-C") {
      const directory = args[index + 1];
      if (!directory) return undefined;
      base = resolveOperand(base, directory);
      index += 1;
      continue;
    }
    if (arg.value === "-c") {
      index += 1;
      continue;
    }
    if (arg.value.startsWith("-")) return undefined;
    return { base, subcommand: arg.value, rest: args.slice(index + 1) };
  }
  return undefined;
}

/** Paths a `git clone` or `git worktree add` invocation creates. */
function gitClaims(args: readonly Argument[], cwd: string | undefined): PathClaim[] {
  const git = parseGitInvocation(args, cwd);
  if (!git) return [];
  if (git.subcommand === "clone") {
    const parsed = parseArguments(git.rest, GIT_CLONE_OPTIONS);
    return parsed ? cloneClaims(parsed.operands, git.base, parsed.flags.has("--bare") || parsed.flags.has("--mirror")) : [];
  }
  if (git.subcommand !== "worktree" || git.rest[0]?.value !== "add") return [];
  const parsed = parseArguments(git.rest.slice(1), GIT_WORKTREE_ADD_OPTIONS);
  const [target] = parsed?.operands ?? [];
  if (!parsed || !target || parsed.operands.length > 2) return [];
  const path = resolveOperand(git.base, target);
  return path === undefined ? [] : [{ path, createsParents: true }];
}

/** `<repository> [<directory>]` operands of a clone. */
function cloneClaims(operands: readonly Argument[], base: string | undefined, bare: boolean): PathClaim[] {
  const [repository, directory] = operands;
  if (!repository || operands.length > 2) return [];
  const name = directory ? undefined : defaultCloneDirectory(repository.value, bare);
  const path = directory
    ? resolveOperand(base, directory)
    : name !== undefined && base !== undefined ? resolve(base, name) : undefined;
  return path === undefined ? [] : [{ path, createsParents: true }];
}

/** Paths a `gh repo clone <repo> [<directory>] [-- <git flags>]` invocation creates. */
function ghClaims(args: readonly Argument[], cwd: string | undefined): PathClaim[] {
  if (args[0]?.value !== "repo" || args[1]?.value !== "clone") return [];
  const rest = args.slice(2);
  const gitFlagsStart = rest.findIndex((arg) => arg.value === "--");
  const own = gitFlagsStart < 0 ? rest : rest.slice(0, gitFlagsStart);
  const gitFlags = gitFlagsStart < 0 ? [] : rest.slice(gitFlagsStart + 1);
  if (gitFlags.some((arg) => arg.value === "--bare" || arg.value === "--mirror")) return [];
  const parsed = parseArguments(own, GH_CLONE_OPTIONS);
  return parsed ? cloneClaims(parsed.operands, cwd, false) : [];
}

function mkdirClaims(args: readonly Argument[], cwd: string | undefined): PathClaim[] {
  const parsed = parseArguments(args, MKDIR_OPTIONS);
  if (!parsed) return [];
  const createsParents = parsed.flags.has("-p") || parsed.flags.has("--parents");
  const claims: PathClaim[] = [];
  for (const operand of parsed.operands) {
    const path = resolveOperand(cwd, operand);
    if (path !== undefined) claims.push({ path, createsParents });
  }
  return claims;
}

/**
 * Paths and temp files that a bash command would create, resolved against the
 * working directory as far as it can be followed in order. Anything the shell
 * would expand at run time is left out instead of guessed.
 */
export function claimsFromBash(analysis: BashAnalysis, cwd: string): CreationClaims {
  const claims: CreationClaims = { paths: [] };
  if (analysis.errors.length > 0) return claims;
  const followCd = analysis.structure.every((token) => CWD_TRACKABLE_STRUCTURE.test(token));
  let current: string | undefined = cwd;
  let mktempCount = 0;
  let mktemp: MktempClaim | undefined;
  for (const command of analysis.commands) {
    const effective = command.effectiveCommand;
    const name = effective.name;
    const unknowable = command.dynamicName || effective.unresolvedTransparentDispatch ||
      (name === "eval" && command.dynamicShellScript) || UNFOLLOWABLE_CWD_COMMANDS.includes(name ?? "");
    if (unknowable) current = undefined;
    if (name === undefined || command.dynamic) {
      if (name === "cd") current = undefined;
      continue;
    }
    const args = effective.args.map((value, index) => ({ value, text: effective.argTexts[index] ?? value }));
    if (name === "cd") {
      current = followCd ? cdTarget(args, current) : undefined;
      continue;
    }
    // `env -C dir cmd` runs `cmd` elsewhere, and the analysis hides that.
    if (command.name === "env" && command.args.some((arg) => arg === "-C" || arg.startsWith("--chdir"))) continue;
    if (name === "mkdir") claims.paths.push(...mkdirClaims(args, current));
    else if (name === "git") claims.paths.push(...gitClaims(args, current));
    else if (name === "gh") claims.paths.push(...ghClaims(args, current));
    else if (name === "mktemp") {
      mktempCount += 1;
      mktemp = mktempClaim(args, current);
    }
  }
  // With several mktemp commands the output cannot be matched back to one.
  if (mktempCount === 1 && mktemp) claims.mktemp = mktemp;
  return claims;
}

/** The new file a `write` call would create. */
export function claimsFromWrite(cwd: string, inputPath: unknown): CreationClaims {
  if (typeof inputPath !== "string" || inputPath === "" || URL_SCHEME.test(inputPath)) return { paths: [] };
  const path = resolveToolInputPath("write", cwd, inputPath);
  return { paths: path === undefined ? [] : [{ path, createsParents: true }] };
}

/** Claims for an allowed tool call; undefined when the tool cannot create tracked paths. */
export function claimsForToolCall(
  toolName: string,
  input: Record<string, unknown>,
  cwd: string,
  analyze: (source: string) => BashAnalysis,
): CreationClaims | undefined {
  if (toolName === "write") return claimsFromWrite(cwd, input.path);
  const command = input.command;
  if (toolName !== "bash" || typeof command !== "string" || !CREATOR_COMMAND_HINT.test(command)) return undefined;
  return claimsFromBash(analyze(command), cwd);
}

/**
 * Record what does not exist yet, before the call runs. A path that already
 * existed is never the session's creation, so it is dropped here.
 */
export function snapshotCreations(claims: CreationClaims, startedAtMs: number): PendingCreation | undefined {
  const paths = new Set<string>();
  for (const claim of claims.paths) {
    const created = claim.createsParents
      ? topmostMissingPath(claim.path)
      : pathExists(claim.path) ? undefined : claim.path;
    if (created !== undefined) paths.add(created);
  }
  if (paths.size === 0 && !claims.mktemp) return undefined;
  return { paths: [...paths], mktemp: claims.mktemp, startedAtMs };
}

/** The mktemp result when the output is exactly one fresh path of the expected shape. */
function mktempOutputPath(claim: MktempClaim, output: string, startedAtMs: number): string | undefined {
  const lines = output.split("\n").map((line) => line.trim()).filter((line) => line !== "");
  const [line] = lines;
  if (lines.length !== 1 || line === undefined) return undefined;
  const path = isAbsolute(line) ? resolve(line) : claim.cwd === undefined ? undefined : resolve(claim.cwd, line);
  if (path === undefined || !claim.basename.test(basename(path))) return undefined;
  try {
    return lstatSync(path).ctimeMs >= startedAtMs - CTIME_SLACK_MS ? path : undefined;
  } catch {
    return undefined;
  }
}

/** The snapshot paths that exist after the call, plus a recovered mktemp path. */
export function confirmCreations(pending: PendingCreation, output: string): string[] {
  const created = pending.paths.filter(pathExists);
  const temp = pending.mktemp && mktempOutputPath(pending.mktemp, output, pending.startedAtMs);
  if (temp) created.push(temp);
  return created;
}

function isRecordablePath(path: string): boolean {
  return isAbsolute(path) && dirname(path) !== path && path.length <= MAX_CREATED_PATH_LENGTH &&
    !UNSAFE_PATH_CHARACTERS.test(path);
}

function isSameOrBeneath(path: string, ancestor: string): boolean {
  return path === ancestor || path.startsWith(ancestor.endsWith(sep) ? ancestor : `${ancestor}${sep}`);
}

/**
 * Add created paths to the tracked list, newest last. A path inside a tracked
 * one only refreshes the tracked one, and a new parent replaces the tracked
 * paths inside it.
 */
export function recordCreatedPaths(existing: readonly string[], created: readonly string[]): string[] {
  let paths = [...existing];
  for (const path of created) {
    if (!isRecordablePath(path)) continue;
    const covering = paths.find((known) => isSameOrBeneath(path, known));
    paths = covering === undefined
      ? [...paths.filter((known) => !isSameOrBeneath(known, path)), path]
      : [...paths.filter((known) => known !== covering), covering];
  }
  return paths.slice(-CREATED_PATHS_LIMIT);
}

/** Tracked paths from a persisted entry; tolerates entries without the field. */
export function restoreCreatedPaths(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return recordCreatedPaths([], value.filter((entry): entry is string => typeof entry === "string"));
}

/** The classifier context block for tracked paths; empty when there are none. */
export function formatSessionCreatedPaths(paths: readonly string[]): string {
  const listed = paths.filter(isRecordablePath).slice(-CLASSIFIER_CREATED_PATHS_LIMIT);
  if (listed.length === 0) return "";
  return [
    `<${SESSION_CREATED_PATHS_TAG}>`,
    "These paths were created by this session's own earlier tool calls, oldest first. Each did NOT exist before this session, and the creating call was allowed and succeeded. The harness recorded this list; it is not part of the transcript.",
    "An action that only deletes, moves, overwrites, or modifies one of these paths, or something beneath it, is the agent cleaning up its own artifact. It is not deleting, truncating, or overwriting local files that existed before session start.",
    "This list does not override hard-deny rules, denied or protected paths, or any other deny rule such as exfiltration or credential handling. Only a listed path and paths beneath it are covered. A path that merely shares a prefix with an entry, or a parent of an entry, is not covered.",
    ...listed.map((path) => `- ${path}`),
    `</${SESSION_CREATED_PATHS_TAG}>`,
  ].join("\n");
}
