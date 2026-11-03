import { isAbsolute, resolve } from "node:path";
import { HOME } from "./constants.ts";
import { conflictsWithProtectedRoots } from "./hard-deny.ts";
import { expandHomePattern, isInside, resolvePathForPolicy } from "./paths.ts";

/** Trees that are never a sensible read-only scratch root, even as a subdirectory. */
const SENSITIVE_ROOT_TREES = ["/proc", "/sys", "/dev", "/etc", "/root"];

/** Expand `~`/`$HOME` and normalize a configured root; undefined when it is not absolute. */
function normalizeReadOnlyRoot(entry: string): string | undefined {
  const expanded = expandHomePattern(entry.trim());
  return isAbsolute(expanded) ? resolve(expanded) : undefined;
}

/**
 * Why a `readOnlyRoots` entry is unacceptable, or undefined when it is valid.
 *
 * Roots must be absolute after `~`/`$HOME` expansion, free of wildcards and
 * `..` segments, and must not be the filesystem root, the home directory (or
 * one of its ancestors), a system root such as `/etc` or `/usr`, or inside a
 * process, device, or credential tree. Such an entry would turn the "skip the
 * classifier" shortcut into a blanket allow.
 */
export function readOnlyRootProblem(entry: string): string | undefined {
  const expanded = expandHomePattern(entry.trim());
  if (expanded.includes("*")) return "wildcards are not supported";
  if (!isAbsolute(expanded)) {
    return "must be an absolute path (or start with ~ or $HOME)";
  }
  if (expanded.split("/").includes("..")) return 'must not contain ".." segments';
  const root = resolve(expanded);
  if (
    conflictsWithProtectedRoots(root, HOME) ||
    SENSITIVE_ROOT_TREES.some((tree) => isInside(root, tree))
  ) {
    return "is the filesystem root, the home directory, or a system root";
  }
  return undefined;
}

/**
 * Whether a symlink-resolved path lies inside one of the configured roots.
 *
 * Each root is resolved through symlinks as well, and a root that resolves to
 * a protected location is ignored, so a symlinked root cannot widen the tier.
 * Comparison is case-sensitive: a differently-cased spelling does not
 * qualify and falls back to the classifier.
 */
export function isInsideReadOnlyRoot(
  policyPath: string,
  roots: readonly string[],
): boolean {
  return roots.some((entry) => {
    const root = normalizeReadOnlyRoot(entry);
    if (root === undefined) return false;
    const canonical = resolvePathForPolicy(root) ?? root;
    if (readOnlyRootProblem(canonical) !== undefined) return false;
    return isInside(policyPath, canonical);
  });
}

/** A tool path that names one local file or directory: no `;` lists, globs, or URL schemes. */
export function isPlainFilePath(value: string): boolean {
  return !/[;*?[\]{}]|:\/\//.test(value);
}
