import { closeSync, existsSync, openSync, readSync, statSync } from "node:fs";
import { dirname, isAbsolute } from "node:path";
import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";

const SESSION_FILE_EXTENSION = ".jsonl";
const MAX_ANCESTOR_DEPTH = 16;
const HEADER_SCAN_BYTES = 64 * 1024;
// A session file is read whole up to head + tail. Beyond that only its first
// and last bytes are read: the opening brief sits at the start and the newest
// user messages at the end. User messages are small, so a tool result that
// straddles a window edge is the only thing lost.
const ROOT_HEAD_BYTES = 256 * 1024;
const ROOT_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_CACHED_FILES = 8;

type SessionManager = ExtensionContext["sessionManager"];

/** A live session of this process that its subagents can read user messages from. */
type ParentContextSource = {
  sessionManager: SessionManager;
  /** Parent named by the session header; set for subagents only. */
  parent: string | undefined;
  file: string | undefined;
};

// Module globals are shared by every session in the process. A session is
// registered under its file and its id because a task subagent's header names
// its parent by file while a `/tan` clone's header names it by id.
const sourcesByKey = new Map<string, ParentContextSource>();

type FileCacheEntry = { mtimeMs: number; size: number; entries: SessionEntry[] };
const entriesByFile = new Map<string, FileCacheEntry>();

function sessionKeys(ctx: ExtensionContext): string[] {
  const keys = [
    ctx.sessionManager.getSessionFile?.(),
    ctx.sessionManager.getSessionId?.(),
  ];
  return keys.filter((key): key is string => typeof key === "string" && key !== "");
}

function agentKind(ctx: ExtensionContext): unknown {
  const agent = "agent" in ctx ? ctx.agent : undefined;
  return typeof agent === "object" && agent !== null && "kind" in agent
    ? agent.kind
    : undefined;
}

/**
 * The parent named by the session header. Pi has no subagents and no `agent`
 * field, and forks and `/new` sessions also name a parent, so only OMP's
 * subagent marker counts.
 */
function subagentParentKey(ctx: ExtensionContext): string | undefined {
  return agentKind(ctx) === "sub"
    ? ctx.sessionManager.getHeader?.()?.parentSession
    : undefined;
}

/** Make a session findable by its subagents. Safe to call again. Pi has no agent identity and is skipped. */
export function registerParentContextSource(ctx: ExtensionContext): void {
  if (agentKind(ctx) === undefined) return;
  const source: ParentContextSource = {
    sessionManager: ctx.sessionManager,
    parent: subagentParentKey(ctx),
    file: ctx.sessionManager.getSessionFile?.(),
  };
  for (const key of sessionKeys(ctx)) {
    sourcesByKey.set(key, source);
  }
}

/** Unregister a shutting-down session so later subagents fall back to its file on disk. */
export function releaseParentContextSource(ctx: ExtensionContext): void {
  for (const key of sessionKeys(ctx)) {
    if (sourcesByKey.get(key)?.sessionManager === ctx.sessionManager) {
      sourcesByKey.delete(key);
    }
  }
}

function readWindow(path: string, start: number, length: number): string {
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(length);
    const bytesRead = readSync(fd, buffer, 0, length, start);
    return buffer.toString("utf8", 0, bytesRead);
  } finally {
    closeSync(fd);
  }
}

function parseLines(text: string): unknown[] {
  const parsed: unknown[] = [];
  for (const line of text.split("\n")) {
    if (line === "") continue;
    try {
      parsed.push(JSON.parse(line));
    } catch {
      // A line cut at a window edge, or a damaged one: skip it.
    }
  }
  return parsed;
}

function isEntry(value: unknown): value is SessionEntry {
  return typeof value === "object" && value !== null && "type" in value &&
    typeof value.type === "string";
}

type SessionHeader = { type: "session"; id?: unknown; parentSession?: unknown };

function isSessionHeader(value: unknown): value is SessionHeader {
  return typeof value === "object" && value !== null && "type" in value &&
    value.type === "session";
}

/** The `session` header line of a session file: its id and the parent it names. */
function readSessionHeader(path: string): { id?: string; parentSession?: string } | undefined {
  try {
    const size = statSync(path).size;
    const header = parseLines(readWindow(path, 0, Math.min(size, HEADER_SCAN_BYTES)))
      .find(isSessionHeader);
    if (header === undefined) return undefined;
    return {
      id: typeof header.id === "string" ? header.id : undefined,
      parentSession: typeof header.parentSession === "string" ? header.parentSession : undefined,
    };
  } catch {
    return undefined;
  }
}

/**
 * Entries of a session file, read-only and bounded. The result is not tied to
 * the active branch: it holds every entry in the window, in file order.
 */
function readSessionEntries(path: string): SessionEntry[] | undefined {
  try {
    const { size, mtimeMs } = statSync(path);
    const cached = entriesByFile.get(path);
    if (cached?.size === size && cached.mtimeMs === mtimeMs) return cached.entries;
    let text: string;
    if (size <= ROOT_HEAD_BYTES + ROOT_TAIL_BYTES) {
      text = readWindow(path, 0, size);
    } else {
      // Each window ends or starts in the middle of a line; cut that line off.
      const head = readWindow(path, 0, ROOT_HEAD_BYTES);
      const tail = readWindow(path, size - ROOT_TAIL_BYTES, ROOT_TAIL_BYTES);
      text = `${head.slice(0, head.lastIndexOf("\n"))}\n${tail.slice(tail.indexOf("\n") + 1)}`;
    }
    const entries = parseLines(text).filter(isEntry);
    if (entriesByFile.size >= MAX_CACHED_FILES) {
      const oldest = entriesByFile.keys().next().value;
      if (oldest !== undefined) entriesByFile.delete(oldest);
    }
    entriesByFile.set(path, { mtimeMs, size, entries });
    return entries;
  } catch {
    return undefined;
  }
}

/**
 * The file a header's parent key names. A path must exist. An id is resolved
 * through the nesting layout (a subagent file sits in the directory named
 * after its parent's file) and the parent file must carry that id.
 */
function resolveParentFile(childFile: string | undefined, key: string): string | undefined {
  if (isAbsolute(key)) return existsSync(key) ? key : undefined;
  if (childFile === undefined) return undefined;
  const nested = dirname(childFile) + SESSION_FILE_EXTENSION;
  return readSessionHeader(nested)?.id === key ? nested : undefined;
}

/**
 * Entries of the root session above a subagent: the main session whose user
 * spawned the chain. Live sessions are looked up by their parent key, hop by
 * hop. A hop this process does not know is read from its session file. A chain
 * that cannot be followed to the root yields undefined, and the caller adds
 * nothing: unknown ancestry never becomes user authority.
 */
export function findRootSessionEntries(ctx: ExtensionContext): SessionEntry[] | undefined {
  let key = subagentParentKey(ctx);
  let childFile = ctx.sessionManager.getSessionFile?.();
  const visited = new Set<string>();
  while (key !== undefined && !visited.has(key) && visited.size < MAX_ANCESTOR_DEPTH) {
    visited.add(key);
    const live = sourcesByKey.get(key);
    if (live) {
      if (live.parent === undefined) return live.sessionManager.getBranch();
      key = live.parent;
      childFile = live.file;
      continue;
    }
    const file = resolveParentFile(childFile, key);
    if (file === undefined) return undefined;
    const grandparent = readSessionHeader(file)?.parentSession;
    if (grandparent === undefined) return readSessionEntries(file);
    const grandparentFile = resolveParentFile(file, grandparent);
    if (grandparentFile === undefined) return undefined;
    // A parent that is not nested under the session it names is a fork of
    // that session, so it is a main session itself.
    if (grandparentFile !== dirname(file) + SESSION_FILE_EXTENSION) {
      return readSessionEntries(file);
    }
    key = grandparent;
    childFile = file;
  }
  return undefined;
}
