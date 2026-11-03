import { createHash, randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import type {
  ClassifierIo,
  ClassifierIoAttempt,
  ClassifierReasoningLog,
  AgentIdentity,
  ClassifierErrorKind,
  ClassifierStage,
  ClassificationDecision,
  DecisionKind,
  DecisionStage,
} from "./types.ts";

const CLASSIFIER_STAGE_BY_MODEL_STAGE: Record<ClassifierStage, DecisionStage> = {
  fast: "classifier-fast",
  detailed: "classifier-detailed",
};

const STAGE_BY_KIND: Partial<Record<DecisionKind, DecisionStage>> = {
  "permissions.deny": "permissions",
  "permissions.ask": "permissions",
  "deterministic-hard-deny": "hard-deny",
  "deterministic-path-deny": "path",
  "inside-working-directory": "inside-cwd",
  "url-scheme": "url-scheme",
  "permissions.allow": "allow",
  "read-only": "read-only",
  "read-only-bash": "read-only",
  "read-only-root": "read-only",
};

/**
 * Enforcement stage behind a decision. `setup` decisions and classifier
 * decisions that never reached a model call have none.
 */
export function decisionStage(
  kind: DecisionKind,
  classifierStage?: ClassifierStage,
): DecisionStage | undefined {
  if (kind === "classifier" || kind === "classifier-unavailable") {
    return classifierStage === undefined
      ? undefined
      : CLASSIFIER_STAGE_BY_MODEL_STAGE[classifierStage];
  }
  return STAGE_BY_KIND[kind];
}

/** A final allow/block decision for a tool call. */
export type DecisionLogEntry = {
  type: "decision";
  ts: string;
  decisionId: string;
  sessionId?: string;
  cwd: string;
  tool: string;
  summary: string;
  kind: DecisionKind;
  outcome: "allow" | "block";
  reason: string;
  classifierModel?: string;
  reasoning: ClassifierReasoningLog;
  /** Time from tool-call receipt to this decision, including any wait on a user prompt. */
  durationMs?: number;
  /** Enforcement stage that decided. Absent for `setup` decisions and when no model call ran. */
  stage?: DecisionStage;
  /** Agent that issued the call, when the host reports one (OMP). */
  agent?: Pick<AgentIdentity, "id" | "name" | "kind">;
  hasUI?: boolean;
  /** Typed cause when the classifier failed closed. */
  errorKind?: ClassifierErrorKind;
  /** Wait the provider requested for a classifier failure, in milliseconds. */
  retryAfterMs?: number;
};

/** The classifier prompt, raw responses, and parsed decision for one action. */
export type ClassifierLogEntry = {
  type: "classifier";
  ts: string;
  decisionId: string;
  model: string;
  reasoning: ClassifierIo["reasoning"];
  prompt: ClassifierIo["prompt"];
  attempts: ClassifierIoAttempt[];
  durationMs: number;
  parsed: ClassificationDecision;
};

/** A ccusage-compatible record for one classifier model response. */
export type ClassifierUsageLogEntry = {
  type: "message";
  timestamp: string;
  message: {
    role: "assistant";
    model: string;
    usage: NonNullable<ClassifierIoAttempt["response"]>["usage"];
  };
};

export type LogEntry =
  | DecisionLogEntry
  | ClassifierLogEntry
  | ClassifierUsageLogEntry;

export type Logger = {
  enabled: boolean;
  classifierIo: boolean;
  append(entry: LogEntry): void;
};

export type LoggerOptions = {
  enabled: boolean;
  classifierIo: boolean;
  sessionFile?: string;
  sessionDir: string;
  /** Effective cwd for an in-memory session. */
  sessionCwd?: string;
  sessionId: string;
  /** Test/embedder override. Runtime uses ~/.pi/agent/extensions/pi-automode/logs under Pi and <agentDir>/automode/logs under omp. */
  logRoot?: string;
  /** Test clock used for the UTC date partition. */
  now?: Date;
};

export const DEFAULT_AUTOMODE_LOG_ROOT = join(
  homedir(),
  ".pi/agent/extensions/pi-automode/logs",
);

const VALID_SESSION_ID =
  /^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

function safeLogSessionId(sessionId: string): string {
  if (VALID_SESSION_ID.test(sessionId)) return sessionId;
  const digest = createHash("sha256")
    .update(sessionId)
    .digest("hex")
    .slice(0, 16);
  return `invalid-${digest}`;
}

/** Short id linking a classifier entry to its decision entry in the same file. */
export function newDecisionId(): string {
  return randomBytes(4).toString("hex");
}

/**
 * Derive the log file path from the current session: the session file's
 * directory with `-pi-automode` inserted before the extension. Falls back to
 * an absolute session directory when one is available. In-memory sessions use
 * an application-owned, project- and date-partitioned directory instead of a
 * relative path resolved against the launching process cwd.
 */
export function resolveLogPath(
  sessionFile: string | undefined,
  sessionDir: string,
  sessionId: string,
  sessionCwd = process.cwd(),
  logRoot = DEFAULT_AUTOMODE_LOG_ROOT,
  now = new Date(),
): string {
  if (sessionFile) {
    const ext = extname(sessionFile);
    const stem = ext ? basename(sessionFile, ext) : basename(sessionFile);
    return join(dirname(sessionFile), `${stem}-pi-automode${ext}`);
  }

  const logFile = `${safeLogSessionId(sessionId)}-pi-automode.jsonl`;
  if (isAbsolute(sessionDir)) {
    return join(sessionDir, logFile);
  }

  const resolvedCwd = resolve(sessionCwd);
  const projectDir = `--${
    resolvedCwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")
  }--`;
  const dateDir = now.toISOString().slice(0, 10);
  const resolvedLogRoot = isAbsolute(logRoot)
    ? logRoot
    : DEFAULT_AUTOMODE_LOG_ROOT;
  return join(
    resolvedLogRoot,
    projectDir,
    dateDir,
    logFile,
  );
}

/** Append one JSON object as a line. Failures are swallowed: logging must
 *  never change a safety decision. */
function appendJsonl(path: string, entry: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    appendFileSync(path, `${JSON.stringify(entry)}\n`, "utf8");
  } catch {
    // Fail open.
  }
}

/** Build a logger bound to one session's log path. No-ops when disabled. */
export function createLogger(opts: LoggerOptions): Logger {
  const { enabled, classifierIo } = opts;
  const path = resolveLogPath(
    opts.sessionFile,
    opts.sessionDir,
    opts.sessionId,
    opts.sessionCwd,
    opts.logRoot,
    opts.now,
  );
  return {
    enabled,
    classifierIo,
    append(entry) {
      if (!enabled) return;
      if (entry.type === "classifier" && !classifierIo) return;
      appendJsonl(path, entry);
    },
  };
}
