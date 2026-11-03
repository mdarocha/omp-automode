import {
  LOCAL_SINGLE_SLASH_PREFIX,
  READ_ONLY_TOOLS,
  READ_ONLY_URL_SCHEMES,
  SELECTOR_PATH_TOOLS,
  URL_SCHEME_PREFIX,
  WEB_URL_PREFIX,
  XD_DEVICE_URL,
} from "./constants.ts";
import { splitPathList, stripToolPathPrefixes } from "./paths.ts";

/**
 * What the `tool_call` hook does with one `scheme://` path entry.
 *
 * - `allow`: a read of a built-in or session-local document.
 * - `scratch`: a write to `local://`, the session scratch root. It is treated
 *   like an in-tree write and follows `allowInsideWorkingDirectory`.
 * - `device`: a write to `xd://<tool>`. OMP runs the mounted tool as a nested
 *   call that emits its own `tool_call`, so the inner call is judged on its own.
 * - `classify`: everything else. The classifier decides and no deterministic
 *   allow tier applies.
 */
export type UrlSchemeDecision =
  | { action: "classify"; scheme: string; entry: string }
  | {
    action: "allow" | "scratch" | "device";
    scheme: string;
    entry: string;
    reason: string;
  };

export interface UrlSchemeOptions {
  /** The `write` tool is OMP's built-in, so `xd://` writes dispatch nested tool calls. */
  deviceDispatch: boolean;
}

const NO_DEVICE_DISPATCH: UrlSchemeOptions = { deviceDispatch: false };

/**
 * Scheme named by one trimmed path entry, or undefined for a filesystem path.
 * Mirrors how OMP recognises URLs: `https:/x`, `www.x`, and `local:/x` count.
 */
export function urlSchemeOf(entry: string): string | undefined {
  const web = WEB_URL_PREFIX.exec(entry);
  if (web) return web[1]?.toLowerCase() ?? "https";
  if (LOCAL_SINGLE_SLASH_PREFIX.test(entry)) return "local";
  const scheme = URL_SCHEME_PREFIX.exec(entry)?.[1]?.toLowerCase();
  // `file://` is a filesystem path that the path gate already resolves.
  return scheme === "file" ? undefined : scheme;
}

function decideUrlScheme(
  toolName: string,
  entry: string,
  scheme: string,
  options: UrlSchemeOptions,
): UrlSchemeDecision {
  if (READ_ONLY_TOOLS.has(toolName)) {
    return READ_ONLY_URL_SCHEMES[scheme] === true
      ? {
        action: "allow",
        scheme,
        entry,
        reason: `Read-only ${scheme}:// resource: ${entry}`,
      }
      : { action: "classify", scheme, entry };
  }
  if (scheme === "local") {
    return {
      action: "scratch",
      scheme,
      entry,
      reason: `Session-local ${scheme}:// scratch write: ${entry}`,
    };
  }
  const device = XD_DEVICE_URL.exec(entry)?.[1];
  if (device && toolName === "write" && options.deviceDispatch) {
    return {
      action: "device",
      scheme,
      entry,
      reason:
        `xd:// device dispatch: the nested ${device} call is classified separately`,
    };
  }
  return { action: "classify", scheme, entry };
}

/** Result of splitting a path argument into URL entries and filesystem entries. */
export interface UrlSchemeGate {
  /** One decision per `scheme://` entry. Never empty. */
  decisions: UrlSchemeDecision[];
  /** Entries that are plain filesystem paths and still need the path gate. */
  pathEntries: string[];
}

/**
 * Split a file tool's `path` into URL entries and filesystem entries before
 * any filesystem resolution. Without this, `xd://propose` resolves to the fake
 * path `<cwd>/xd:/propose` and passes the inside-working-directory tier.
 *
 * `read` and `grep` split `;`, `,` and whitespace lists, so each entry is
 * judged separately. Returns undefined when no entry is a URL.
 */
export function gateUrlSchemePath(
  toolName: string,
  value: string,
  options: UrlSchemeOptions = NO_DEVICE_DISPATCH,
): UrlSchemeGate | undefined {
  const entries = SELECTOR_PATH_TOOLS[toolName] === true
    ? splitPathList(value)
    : [value.trim()];
  const decisions: UrlSchemeDecision[] = [];
  const pathEntries: string[] = [];
  for (const rawEntry of entries) {
    const entry = stripToolPathPrefixes(rawEntry);
    const scheme = urlSchemeOf(entry);
    if (scheme === undefined) {
      pathEntries.push(rawEntry);
    } else {
      decisions.push(decideUrlScheme(toolName, entry, scheme, options));
    }
  }
  return decisions.length > 0 ? { decisions, pathEntries } : undefined;
}
