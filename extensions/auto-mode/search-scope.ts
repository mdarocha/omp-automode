import { resolve } from "node:path";
import {
  canonicalizeCase,
  deniedPatternVariants,
  matchesDeniedPath,
  wildcardCanMatchDescendant,
  withoutTrailingSlash,
} from "./permissions.ts";
import {
  parseJsonPathArray,
  resolvePathForPolicy,
  resolveToolInputPath,
  splitPathList,
} from "./paths.ts";
import { urlSchemeOf } from "./url-schemes.ts";

/** `;`-separated list entry that OMP's `grep` reads as an exclusion instead of a path. */
const EXCLUSION_PREFIX = "!";

/** Glob that excludes a file or directory at any depth below the search root. */
const ANY_DEPTH = "**/";

/** Characters OMP rewrites or splits on before a `!glob` entry reaches its glob matcher. */
const UNWRITABLE_GLOB_TEXT = /[\\{};\u0000-\u001f]/;

/** Upper bound on appended exclusions, so a long `deniedPaths` list cannot bloat `path`. */
const MAX_EXCLUSIONS = 64;

/** Glob metacharacters, other than `*`, that are written as one-character classes. */
const GLOB_CLASS_ESCAPES = /[?[\]]/;

const GLOB_CHARS = /[*?[{]/;

/**
 * Write literal path text as a glob that matches it regardless of case.
 *
 * `deniedPaths` matching is case-insensitive and Unicode-normalising, while
 * the glob matcher is neither. Letters become `[xX]` and non-ASCII characters
 * become `*`, so the glob only ever matches more than the pattern does.
 * Returns undefined for text that cannot be written in an exclusion entry.
 */
function literalGlob(text: string): string | undefined {
  if (UNWRITABLE_GLOB_TEXT.test(text) || text !== text.trimEnd()) {
    return undefined;
  }
  let glob = "";
  for (const character of text) {
    if (character === "/") {
      glob += character;
    } else if (/[a-z]/i.test(character)) {
      glob += `[${character.toLowerCase()}${character.toUpperCase()}]`;
    } else if (GLOB_CLASS_ESCAPES.test(character)) {
      glob += `[${character}]`;
    } else if (character.charCodeAt(0) > 127) {
      // Adjacent `*` collapse: OMP only treats a whole `**` component as recursive.
      if (!glob.endsWith("*")) glob += "*";
    } else {
      glob += character;
    }
  }
  return glob;
}

/**
 * Globs, relative to the search root and matching at any depth, that drop
 * every file under `root` which one `deniedPaths` pattern variant matches.
 *
 * A matched directory drops its whole subtree, so each glob only has to name
 * a prefix or the suffix of the denied path:
 * - without a wildcard, the denied path itself;
 * - with wildcards, the literal text before the first `*` (when it lies inside
 *   the root) or the literal text after the last `*`, whichever is longer.
 *
 * Returns [] when the pattern cannot match a file under `root`, and undefined
 * when no glob can describe it (it matches the whole tree, or needs text that
 * an exclusion entry cannot carry).
 */
function exclusionsForPattern(
  root: string,
  pattern: string,
): string[] | undefined {
  const rootPrefix = withoutTrailingSlash(root) === "/"
    ? "/"
    : `${withoutTrailingSlash(root)}/`;
  // A path never ends with `/`, so a pattern that does matches no file.
  if (pattern.endsWith("/")) return [];
  const wildcardIndex = pattern.indexOf("*");
  if (wildcardIndex < 0) {
    const relative = pattern.slice(rootPrefix.length);
    const glob = literalGlob(relative);
    return glob === undefined || glob === "" ? undefined : [`${ANY_DEPTH}${glob}`];
  }

  const before = pattern.slice(0, wildcardIndex);
  const after = pattern.slice(pattern.lastIndexOf("*") + 1);

  const candidates: { weight: number; glob: string }[] = [];
  if (
    canonicalizeCase(before).startsWith(canonicalizeCase(rootPrefix)) &&
    before.length > rootPrefix.length
  ) {
    const relative = before.slice(rootPrefix.length);
    const slash = relative.lastIndexOf("/");
    const directory = literalGlob(relative.slice(0, slash + 1));
    const partial = literalGlob(relative.slice(slash + 1));
    if (directory !== undefined && partial !== undefined) {
      candidates.push({
        weight: relative.length,
        glob: `${ANY_DEPTH}${directory}${partial}*`,
      });
    }
  }
  if (after !== "") {
    const [partial = "", ...names] = after.split("/");
    const glob = literalGlob(names.join("/"));
    const head = literalGlob(partial);
    if (glob !== undefined && head !== undefined) {
      const tail = names.length > 0 ? `/${glob}` : "";
      candidates.push({
        weight: after.length,
        glob: partial === "" && names.length > 0
          ? `${ANY_DEPTH}${glob}`
          : `${ANY_DEPTH}*${head}${tail}`,
      });
    }
  }
  const best = candidates.sort((a, b) => b.weight - a.weight)[0];
  return best ? [best.glob] : undefined;
}

/**
 * `!glob` entries that keep every file matched by `deniedPaths` out of a
 * recursive search of `roots`, or undefined when that cannot be guaranteed.
 *
 * `roots` holds every spelling of the search roots (typed and symlink-resolved
 * absolute paths); `deniedPaths` matches both spellings of a file, so both are
 * covered.
 */
export function deniedSearchExclusions(
  roots: string[],
  deniedPaths: string[],
): string[] | undefined {
  const exclusions = new Set<string>();
  for (const pattern of deniedPaths) {
    for (const variant of deniedPatternVariants(pattern)) {
      for (const root of roots) {
        if (!wildcardCanMatchDescendant(root, variant)) continue;
        const globs = exclusionsForPattern(root, variant);
        if (globs === undefined) return undefined;
        for (const glob of globs) exclusions.add(`${EXCLUSION_PREFIX}${glob}`);
      }
    }
  }
  return exclusions.size > MAX_EXCLUSIONS ? undefined : [...exclusions];
}

/**
 * Directories a `grep` path will walk: each non-exclusion entry, cut at its
 * first glob segment the way OMP finds the walkable base. Returns undefined
 * when an entry cannot be turned into a root (a URL does not name a local one).
 */
function grepSearchRoots(entries: string[]): string[] | undefined {
  const roots: string[] = [];
  for (const entry of entries) {
    if (entry.startsWith(EXCLUSION_PREFIX)) continue;
    if (urlSchemeOf(entry) !== undefined) return undefined;
    const segments = entry.split("/");
    const globIndex = segments.findIndex((segment) => GLOB_CHARS.test(segment));
    if (globIndex < 0) roots.push(entry);
    else roots.push(segments.slice(0, globIndex).join("/") || (globIndex === 0 && entry.startsWith("/") ? "/" : "."));
  }
  return roots;
}

/**
 * Append `!glob` exclusions to a `grep` path the way OMP reads them: as extra
 * entries of a `;` list, or as extra elements of a JSON-encoded array.
 * Returns undefined for a path whose list syntax an appended entry could break.
 */
function appendExclusions(
  value: string | undefined,
  exclusions: string[],
): string | undefined {
  const typed = value === undefined || value.trim() === "" ? "." : value;
  const elements = parseJsonPathArray(typed);
  if (elements) return JSON.stringify([...elements, ...exclusions]);
  const opens = typed.split("{").length - 1;
  const closes = typed.split("}").length - 1;
  if (opens !== closes || typed.includes("\\")) return undefined;
  return [typed, ...exclusions].join(";");
}

/**
 * Narrow a recursive `grep` so denied files are never searched. Returns the
 * revised tool input, or undefined when the exclusions cannot be guaranteed
 * and the call must be blocked instead.
 */
export function narrowGrepSearch(
  input: Record<string, unknown>,
  cwd: string,
  deniedPaths: string[],
): Record<string, unknown> | undefined {
  const typed = typeof input.path === "string" ? input.path : undefined;
  let entries = ["."];
  if (typed !== undefined && typed.trim() !== "") {
    // A JSON-encoded array is only a list; any other value may also be one path.
    entries = parseJsonPathArray(typed)
      ? splitPathList(typed)
      : [typed, ...splitPathList(typed)];
  }
  const roots = grepSearchRoots(entries);
  if (roots === undefined) return undefined;
  const spellings = new Set<string>();
  for (const root of roots) {
    const resolved = resolveToolInputPath("grep", cwd, root);
    if (resolved === undefined) return undefined;
    spellings.add(resolved);
    spellings.add(resolvePathForPolicy(resolved) ?? resolved);
  }
  const exclusions = deniedSearchExclusions([...spellings], deniedPaths);
  if (exclusions === undefined) return undefined;
  const path = appendExclusions(typed, exclusions);
  return path === undefined ? undefined : { ...input, path };
}

/**
 * Files in a `grep` result that `deniedPaths` matches. Returns undefined when
 * the result does not list its files, so a caller that cannot verify the
 * exclusions drops the result instead of trusting it.
 */
export function deniedGrepResultFiles(
  details: unknown,
  cwd: string,
  deniedPaths: string[],
): string[] | undefined {
  const files = (details as { files?: unknown } | null | undefined)?.files;
  if (!Array.isArray(files) || files.some((file) => typeof file !== "string")) {
    return undefined;
  }
  return (files as string[]).filter((file) => {
    const resolved = resolve(cwd, file);
    return matchesDeniedPath(resolved, deniedPaths) ||
      matchesDeniedPath(resolvePathForPolicy(resolved) ?? resolved, deniedPaths);
  });
}
