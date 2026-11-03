import {
  accessSync,
  constants,
  lstatSync,
  readlinkSync,
  realpathSync,
} from "node:fs";
import {
  basename,
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from "node:path";
import { fileURLToPath } from "node:url";
import {
  HOME,
  OMP_DEFAULT_AGENT_DIR,
  OMP_GLOBAL_DATA_DIR_NAME,
  PATH_BEARING_TOOLS,
  PATH_LIST_DELIMITERS,
  PATH_SELECTOR_BOUNDARY,
  PI_AGENT_DIR,
  PROFILE_FILES,
  SELECTOR_PATH_TOOLS,
} from "./constants.ts";

const PROJECT_CONFIG_DIR = /\/\.(?:pi|omp)\//;
const PROJECT_CONFIG_EXTENSIONS_DIR = /\/\.(?:pi|omp)\/extensions\//;

const UNICODE_SPACES = /[\u00A0\u2000-\u200A\u202F\u205F\u3000]/g;

/** omp drops a stray `:` that precedes a path shape (`:/abs`, `:~/x`, `:./x`, `:C:`). */
const STRAY_LEADING_COLON = /^:(?=[/\\~]|\.\.?[/\\]|[A-Za-z]:)/;

/** Convert Git Bash, MSYS, Cygwin, and WSL drive paths for Windows APIs. */
function normalizeWindowsShellPath(path: string): string {
  if (
    process.platform !== "win32" ||
    !path.startsWith("/") ||
    path.startsWith("//") ||
    path.includes("\\")
  ) {
    return path;
  }
  const match = path.match(/^\/(?:mnt\/|cygdrive\/)?([a-z])(?:\/(.*))?$/i);
  if (!match) return path;
  const suffix = match[2]?.replaceAll("/", "\\");
  return `${match[1]?.toUpperCase()}:\\${suffix ?? ""}`;
}

/**
 * `file://` URL to a path, the way OMP does it: case-insensitive scheme, and an
 * invalid URL stays as typed so the tool opens the same path the policy sees.
 */
function stripFileUrl(value: string): string {
  if (!/^file:\/\//i.test(value)) return value;
  try {
    return fileURLToPath(value);
  } catch {
    return value;
  }
}

/** Drop the prefixes OMP tools tolerate before a path: a stray `:` and one `@`. */
export function stripToolPathPrefixes(value: string): string {
  const withoutColon = STRAY_LEADING_COLON.test(value)
    ? value.slice(1)
    : value;
  return withoutColon.startsWith("@") ? withoutColon.slice(1) : withoutColon;
}

/** Mirror Pi's path normalization options. */
function normalizeInputPath(
  value: string,
  options: { normalizeUnicodeSpaces?: boolean; stripAtPrefix?: boolean } = {},
): string {
  let normalized = options.normalizeUnicodeSpaces
    ? value.replace(UNICODE_SPACES, " ")
    : value;
  if (options.stripAtPrefix) normalized = stripToolPathPrefixes(normalized);
  normalized = normalizeWindowsShellPath(normalized);
  if (normalized === "~") return HOME;
  if (
    normalized.startsWith("~/") ||
    (process.platform === "win32" && normalized.startsWith("~\\"))
  ) {
    return join(HOME, normalized.slice(2));
  }
  return stripFileUrl(normalized);
}

export function resolveInputPath(
  cwd: string,
  value: unknown,
): string | undefined {
  if (typeof value !== "string") return undefined;
  const normalized = normalizeInputPath(value, {
    normalizeUnicodeSpaces: true,
    stripAtPrefix: true,
  });
  return isAbsolute(normalized)
    ? resolve(normalized)
    : resolve(normalizeInputPath(cwd), normalized);
}

function existingReadVariant(path: string): string {
  const candidates = [
    path,
    path.replace(/ (AM|PM)\./gi, "\u202F$1."),
    path.normalize("NFD"),
    path.replace(/'/g, "\u2019"),
    path.normalize("NFD").replace(/'/g, "\u2019"),
  ];
  for (const candidate of candidates) {
    try {
      accessSync(candidate, constants.F_OK);
      return candidate;
    } catch {
      // Try the next Pi-compatible read fallback.
    }
  }
  return path;
}

/** Resolve the path that the named Pi file tool will operate on. */
export function resolveToolInputPath(
  toolName: string,
  cwd: string,
  value: unknown,
): string | undefined {
  const resolved = resolveInputPath(cwd, value);
  if (!resolved || toolName !== "read") return resolved;
  return existingReadVariant(resolved);
}

/** omp trims a path entry and drops one pair of surrounding double quotes. */
function normalizePathEntry(entry: string): string {
  const trimmed = entry.trim();
  return trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"')
    ? trimmed.slice(1, -1)
    : trimmed;
}

/** A `path` that is a JSON-encoded string array, which OMP's `grep` reads as a list. */
export function parseJsonPathArray(value: string): string[] | undefined {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return undefined;
  try {
    const parsed: unknown = JSON.parse(trimmed);
    return Array.isArray(parsed) &&
        parsed.every((entry) => typeof entry === "string")
      ? parsed
      : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The entries OMP's `read` and `grep` split one `path` argument into: the
 * `;`, `,` and whitespace separated parts, or the elements of a JSON-encoded
 * array and their parts. The caller still checks the typed value itself.
 */
export function splitPathList(value: string): string[] {
  const elements = parseJsonPathArray(value);
  const sources = elements
    ? elements.flatMap((element) => [element, ...element.split(PATH_LIST_DELIMITERS)])
    : value.split(PATH_LIST_DELIMITERS);
  return sources.map(normalizePathEntry).filter(Boolean);
}

/**
 * Every path omp's `read` and `grep` may operate on for one `path` argument.
 *
 * omp does not treat `path` as one literal file name: it peels read selectors
 * (`:5-9`, `:raw`), addresses members and tables inside archives and
 * databases (`a.zip:member`, `app.db:table:key`), accepts `?query` suffixes
 * and splits `;`, `,` or whitespace separated lists. Policy that only saw the
 * literal string would miss `~/.netrc:1-2` or `README.md;~/.netrc`.
 *
 * The literal value always comes first. It is followed by each delimited
 * entry and every prefix of those entries that ends right before a `:` or `?`.
 * Callers that deny must match any variant; callers that allow must require
 * every variant to pass. Prefixes that are not real files are harmless: they
 * only add candidates.
 */
export function inputPathVariants(toolName: string, value: string): string[] {
  if (SELECTOR_PATH_TOOLS[toolName] !== true) return [value];
  const variants = new Set<string>([value]);
  for (const typed of [normalizePathEntry(value), ...splitPathList(value)]) {
    // OMP converts a `file://` URL before it peels selectors from the path.
    const entry = stripFileUrl(typed);
    variants.add(typed);
    variants.add(entry);
    for (let index = 1; index < entry.length; index += 1) {
      if (PATH_SELECTOR_BOUNDARY.test(entry.charAt(index))) {
        variants.add(entry.slice(0, index));
      }
    }
  }
  return [...variants];
}

/** Resolve every {@link inputPathVariants} entry the way the named tool would. */
export function resolveToolInputPaths(
  toolName: string,
  cwd: string,
  value: unknown,
): string[] {
  if (typeof value !== "string") return [];
  const resolved = new Set<string>();
  for (const variant of inputPathVariants(toolName, value)) {
    const path = resolveToolInputPath(toolName, cwd, variant);
    if (path !== undefined) resolved.add(path);
  }
  return [...resolved];
}

/** The effective target path of a file tool, including Pi's `.` defaults. */
export function extractInputPath(
  toolName: string,
  input: Record<string, unknown>,
): string | undefined {
  if (!PATH_BEARING_TOOLS.has(toolName)) return undefined;
  const value = input.path;
  if (typeof value === "string" && value !== "") return value;
  if (toolName === "grep" || toolName === "find" || toolName === "ls") {
    return ".";
  }
  return typeof value === "string" ? value : undefined;
}

/** Expand a leading `~`, `$HOME`, or `${HOME}` in a path-denial pattern. */
export function expandHomePattern(pattern: string): string {
  const home = HOME.replace(/\\/g, "/");
  if (pattern === "~" || pattern === "$HOME" || pattern === "${HOME}") {
    return home;
  }
  if (pattern.startsWith("~/")) return `${home}/${pattern.slice(2)}`;
  if (pattern.startsWith("$HOME/")) return `${home}/${pattern.slice(6)}`;
  if (pattern.startsWith("${HOME}/")) return `${home}/${pattern.slice(8)}`;
  return pattern;
}

export function normalizePathForMatch(path: string, cwd: string): string {
  const normalized = normalize(path);
  const rel = relative(cwd, normalized);
  return rel && !rel.startsWith("..") && !isAbsolute(rel) ? rel : normalized;
}

export function isInside(child: string, parent: string): boolean {
  const rel = relative(parent, child);
  return rel === "" || (!!rel && !rel.startsWith("..") && !isAbsolute(rel));
}

/** Resolve symlinks through the nearest existing ancestor of a path. */
export function resolvePathForPolicy(path: string): string | undefined {
  return resolvePathForPolicyInner(resolve(path), new Set<string>());
}

function resolvePathForPolicyInner(
  path: string,
  visitedSymlinks: Set<string>,
): string | undefined {
  let current = path;
  const missingSegments: string[] = [];

  while (true) {
    try {
      return resolve(realpathSync(current), ...missingSegments);
    } catch {
      try {
        const stat = lstatSync(current);
        if (!stat.isSymbolicLink() || visitedSymlinks.has(current)) {
          return undefined;
        }
        visitedSymlinks.add(current);
        const target = resolve(dirname(current), readlinkSync(current));
        return resolvePathForPolicyInner(
          resolve(target, ...missingSegments),
          visitedSymlinks,
        );
      } catch (error) {
        const code = error && typeof error === "object" && "code" in error
          ? String(error.code)
          : undefined;
        if (code !== "ENOENT" && code !== "ENOTDIR") return undefined;
        const parent = dirname(current);
        if (parent === current) return undefined;
        missingSegments.unshift(basename(current));
        current = parent;
      }
    }
  }
}

function normalizeProtectedPathForMatch(value: string): string {
  return value
    .replace(/\\/g, "/")
    .normalize("NFC")
    .toLowerCase()
    .normalize("NFC");
}

export function matchesProtectedPath(
  relativePath: string,
  protectedPaths: string[],
): boolean {
  const normalizedPath = normalizeProtectedPathForMatch(relativePath);
  return protectedPaths.some((pattern) => {
    const normalizedPattern = normalizeProtectedPathForMatch(pattern);
    return normalizedPath === normalizedPattern ||
      normalizedPath.startsWith(`${normalizedPattern}/`);
  });
}

export function isProtectedPath(
  path: string,
  cwd: string,
  protectedPaths: string[],
): boolean {
  // Resolve through the nearest existing ancestor so symlinked directories are
  // respected even when the final write target does not exist yet.
  const resolved = resolvePathForPolicy(path) ?? path;
  const resolvedCwd = resolvePathForPolicy(cwd) ?? cwd;

  // For paths inside the project: use relative path for matching.
  if (isInside(resolved, resolvedCwd)) {
    return matchesProtectedPath(
      relative(resolvedCwd, resolved),
      protectedPaths,
    );
  }

  // For paths outside the project: check every path component suffix.
  // This catches writes like ../other-project/.git/config even when cwd
  // doesn't contain the target.
  const normalizedResolved = resolved.replace(/\\/g, "/");
  const segments = normalizedResolved.split("/").filter(Boolean);
  for (let i = 0; i < segments.length; i++) {
    if (matchesProtectedPath(segments.slice(i).join("/"), protectedPaths)) {
      return true;
    }
  }
  return false;
}

/** omp agent directories that are protected in addition to the default one. */
const registeredOmpAgentDirs = new Set<string>();

/**
 * Protect the automode data directory and extensions of the omp agent
 * directory that is active in this process (profile or `PI_CONFIG_DIR`).
 */
export function registerOmpAgentDir(agentDir: string): void {
  const resolved = resolve(agentDir);
  registeredOmpAgentDirs.add(normalizeProtectedPathForMatch(resolved));
  // Policy checks compare symlink-resolved paths, so register that form too.
  registeredOmpAgentDirs.add(
    normalizeProtectedPathForMatch(resolvePathForPolicy(resolved) ?? resolved),
  );
}

function isUnderRoot(normalized: string, root: string): boolean {
  return normalized === root || normalized.startsWith(`${root}/`);
}

function isGlobalSafetyControlPath(normalized: string): boolean {
  const piAgentRoot = normalizeProtectedPathForMatch(PI_AGENT_DIR);
  if (
    normalized === `${piAgentRoot}/settings.json` ||
    isUnderRoot(normalized, `${piAgentRoot}/extensions`) ||
    isUnderRoot(normalized, `${piAgentRoot}/settings`)
  ) {
    return true;
  }
  const ompAgentRoots = new Set([
    normalizeProtectedPathForMatch(OMP_DEFAULT_AGENT_DIR),
    ...registeredOmpAgentDirs,
  ]);
  for (const root of ompAgentRoots) {
    if (
      isUnderRoot(normalized, `${root}/extensions`) ||
      isUnderRoot(normalized, `${root}/${OMP_GLOBAL_DATA_DIR_NAME}`)
    ) {
      return true;
    }
  }
  return false;
}

export function isSafetyControlPath(path: string, cwd: string): boolean {
  const policyPath = resolvePathForPolicy(path) ?? resolve(path);
  const policyCwd = resolvePathForPolicy(cwd) ?? resolve(cwd);
  const normalized = normalizeProtectedPathForMatch(policyPath);
  const file = basename(normalized);
  if (isGlobalSafetyControlPath(normalized)) {
    return true;
  }
  if (
    normalized.endsWith("/.pi/auto-mode.json") ||
    normalized.endsWith("/auto-mode.json")
  ) {
    return true;
  }
  if (PROJECT_CONFIG_EXTENSIONS_DIR.test(normalized) && file.includes("auto")) {
    return true;
  }
  if (PROJECT_CONFIG_DIR.test(normalized) && file.startsWith("automode")) {
    return true;
  }
  if (
    normalized.includes("/pi-automode/") ||
    (isInside(policyPath, policyCwd) && file.includes("auto-mode"))
  ) {
    return true;
  }
  return false;
}

export function shellPathTokenToPath(
  token: string,
  cwd: string | undefined,
  shellText = token,
): string | undefined {
  let value = token.trim();
  if (!value || value === "-" || value.startsWith("&")) return undefined;
  value = value
    .replace(/^\$HOME(?=\/|$)/, HOME)
    .replace(/^\$\{HOME\}(?=\/|$)/, HOME);
  if (shellText === "~") value = HOME;
  else if (shellText.startsWith("~/")) value = resolve(HOME, value.slice(2));
  return isAbsolute(value)
    ? resolve(value)
    : cwd === undefined
    ? undefined
    : resolve(cwd, value);
}

export function isProfileOrAuthorizedKeysPath(
  path: string,
): string | undefined {
  if (PROFILE_FILES.has(path)) {
    return "shell profile modification is hard-denied";
  }
  const authorizedKeys = resolve(HOME, ".ssh/authorized_keys");
  if (path === authorizedKeys) {
    return "SSH authorized_keys modification is hard-denied";
  }
  const policyPath = resolvePathForPolicy(path);
  if (policyPath === undefined) return undefined;
  for (const profile of PROFILE_FILES) {
    if (policyPath === resolvePathForPolicy(profile)) {
      return "shell profile modification is hard-denied";
    }
  }
  if (policyPath === resolvePathForPolicy(authorizedKeys)) {
    return "SSH authorized_keys modification is hard-denied";
  }
  return undefined;
}
