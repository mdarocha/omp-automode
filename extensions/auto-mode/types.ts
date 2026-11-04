import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ClassifierReasoningLevel =
  | "low"
  | "medium"
  | "high"
  | "xhigh"
  | "max";

export type EffectiveClassifierReasoningLevel =
  | "off"
  | "minimal"
  | ClassifierReasoningLevel;

export type ClassifierReasoning =
  | { mode: "server-default" }
  | {
    mode: "explicit";
    requestedLevel: ClassifierReasoningLevel;
    effectiveLevel: EffectiveClassifierReasoningLevel;
  };

export type ClassifierReasoningLog =
  | ClassifierReasoning
  | {
    mode: "explicit";
    requestedLevel: ClassifierReasoningLevel;
    effectiveLevel?: undefined;
  };

/** Observability log configuration. Off by default. */
export type LogConfig = {
  enabled: boolean;
  /** When true, also log classifier prompt/response payloads. */
  classifierIo: boolean;
};

/**
 * Where a `permissions.ask` match goes in a session that has no UI of its own:
 * `parent` asks the nearest ancestor session that has one, `classifier` skips
 * the question and sends the call to the classifier, `block` blocks it.
 */
export type HeadlessAskMode = "parent" | "classifier" | "block";

export type AutoModeSettings = {
  enabled?: boolean;
  classifierModel?: string;
  classifierReasoningLevel?: ClassifierReasoningLevel;
  /** When true, read-only tools (read/grep/find/ls) are classified instead of auto-allowed. */
  classifyReadOnlyTools?: boolean;
  /** Override the fast-stage completion token budget (default 512). */
  fastClassifierMaxTokens?: number;
  /** Per-request timeout for classifier completions in milliseconds (default 20000). */
  classifierTimeoutMs?: number;
  /** When true, file tools whose resolved path is inside the working directory are allowed deterministically (no classifier), and outside-CWD file access is classified. */
  allowInsideWorkingDirectory?: boolean;
  /** What a `permissions.ask` match does in a session without UI (default `parent`). */
  headlessAsk?: HeadlessAskMode;
  /** Path glob patterns (file tools) that are always denied before the classifier. Supports `~` and `*` (matches any characters, including `/`). */
  deniedPaths?: unknown;
  /** When true, bash commands that are provably pure reads skip the classifier. Never read from shared project config. */
  allowReadOnlyBash?: boolean;
  /** Absolute directories outside the working directory where read/grep/find/ls skip the classifier. Supports `~` and `$HOME`. Never read from shared project config. */
  readOnlyRoots?: unknown;
  maxUserTranscriptTokens?: number;
  maxToolTranscriptTokens?: number;
  /** Keep at most this many ordinary user, coordinator, and peer messages (default 30). Pinned entries are exempt. */
  maxUserTranscriptMessages?: number;
  /** Keep at most this many recent tool calls (default 40). */
  maxToolTranscriptCalls?: number;
  /** Send bounded, untrusted excerpts of recent tool results to the classifier (default true). */
  includeToolResults?: boolean;
  /** Approximate-token budget for all tool-result excerpts together (default 2000). */
  maxToolResultTranscriptTokens?: number;
  /** Keep at most this many recent tool results (default 10). */
  maxToolResultTranscriptEntries?: number;
  /** Under an OMP subagent, add the main session's user messages to the classifier context (default true). */
  includeParentUserMessages?: boolean;
  /** Approximate-token budget for those messages (default 2000). */
  maxParentUserTranscriptTokens?: number;
  /** Keep at most this many of them (default 6). The first brief and ask answers are pinned. */
  maxParentUserTranscriptMessages?: number;
  environment?: unknown;
  allow?: unknown;
  protectedPaths?: unknown;
  soft_deny?: unknown;
  softDeny?: unknown;
  hard_deny?: unknown;
  hardDeny?: unknown;
  log?: Partial<LogConfig>;
};

export type SettingsFile = {
  autoMode?: AutoModeSettings;
  permissions?: {
    deny?: unknown;
    ask?: unknown;
    /**
     * Deterministic allow tier: matching calls skip the classifier only. Read
     * from user-owned config sources, never shared project config.
     */
    allow?: unknown;
  };
};

export type LoadedSettingsFile = {
  path: string;
  settings?: SettingsFile;
  diagnostics: string[];
};

export type ToolPattern = {
  raw: string;
  toolName?: string;
  argumentPattern?: string;
};

export type EffectiveConfig = {
  enabled: boolean;
  classifierModel?: string;
  classifierReasoningLevel?: ClassifierReasoningLevel;
  classifyReadOnlyTools: boolean;
  fastClassifierMaxTokens: number;
  classifierTimeoutMs: number;
  allowInsideWorkingDirectory: boolean;
  headlessAsk: HeadlessAskMode;
  deniedPaths: string[];
  allowReadOnlyBash: boolean;
  readOnlyRoots: string[];
  maxUserTranscriptTokens: number;
  maxToolTranscriptTokens: number;
  maxUserTranscriptMessages: number;
  maxToolTranscriptCalls: number;
  includeToolResults: boolean;
  maxToolResultTranscriptTokens: number;
  maxToolResultTranscriptEntries: number;
  includeParentUserMessages: boolean;
  maxParentUserTranscriptTokens: number;
  maxParentUserTranscriptMessages: number;
  environment: string[];
  allow: string[];
  protectedPaths: string[];
  softDeny: string[];
  hardDeny: string[];
  permissionDeny: ToolPattern[];
  permissionAsk: ToolPattern[];
  permissionAllow: ToolPattern[];
  log: LogConfig;
  /** Scope that last set `enabled`; absent in hand-built configs, meaning `default`. */
  enabledSource?: ConfigScope;
};

export type AutoModeState = {
  lastDecision?: "allow" | "block";
  lastReason?: string;
  checkedActions: number;
  blockedActions: number;
  classifierAllowed: number;
  classifierDenied: number;
  recentDenials: DenialRecord[];
  /** Kind of the last decision. Unlike `lastReason`, it is safe to show the model. */
  lastDecisionKind?: DecisionKind;
  recentClassifierErrors: ClassifierErrorRecord[];
  /** Absolute paths this session's allowed, successful calls created, newest last. */
  createdPaths: string[];
};

export type DenialRecord = {
  timestamp: number;
  toolName: string;
  reason: string;
  action: string;
  kind:
    | "permissions.deny"
    | "permissions.ask"
    | "deterministic-hard-deny"
    | "deterministic-path-deny"
    | "classifier"
    | "classifier-unavailable"
    | "setup";
};

/** Denial kind plus the deterministic allow fast paths, used for decision log entries. */
export type DecisionKind =
  | DenialRecord["kind"]
  | "permissions.allow"
  | "read-only"
  | "read-only-bash"
  | "read-only-root"
  | "inside-working-directory"
  | "url-scheme";

/**
 * Why a classifier call failed closed. `rate-limit`, `timeout`, `auth`,
 * `server`, and `aborted` are provider-call failures; `server` also covers
 * errors nothing else recognises. `invalid-response` is an unusable answer or a
 * request the provider rejected, `context-limit` an action too large for the
 * model, and `no-classifier` the lack of any usable model or credential.
 */
export type ClassifierErrorKind =
  | "rate-limit"
  | "timeout"
  | "auth"
  | "server"
  | "aborted"
  | "invalid-response"
  | "context-limit"
  | "no-classifier";

export type ClassifierStage = "fast" | "detailed";

/** Typed cause of a fail-closed classifier block. */
export type ClassifierFailure = {
  kind: ClassifierErrorKind;
  /**
   * The provider's or harness's error text. It only feeds block reasons: the
   * decision log and `automode_inspect` record `kind`, `stage`, and
   * `retryAfterMs`, never this.
   */
  message?: string;
  /** Stage that failed, when the failure happened inside one. */
  stage?: ClassifierStage;
  /** Wait the provider requested, when its error carried one. */
  retryAfterMs?: number;
};

/** A recent fail-closed classifier failure, kept for `automode_inspect`. */
export type ClassifierErrorRecord = Omit<ClassifierFailure, "message"> & {
  timestamp: number;
  /** Classifier model, as `provider/id`, when one was resolved. */
  model?: string;
};

/** Which enforcement stage produced a decision. */
export type DecisionStage =
  | "permissions"
  | "hard-deny"
  | "path"
  | "inside-cwd"
  | "url-scheme"
  | "allow"
  | "read-only"
  | "classifier-fast"
  | "classifier-detailed";

/** Settings scope that last set `autoMode.enabled`; `default` when none did. */
export type ConfigScope = "default" | "global" | "project-local" | "inline";

/** Where the effective enabled state came from. */
export type EnabledSource = ConfigScope | "override" | "parent";

/** Agent identity the host reports on the extension context (OMP `ctx.agent`). */
export type AgentIdentity = {
  kind?: string;
  id?: string;
  name?: string;
  depth?: number;
};

export type ClassificationDecision = {
  decision: "allow" | "block";
  tier: "hard_deny" | "soft_deny" | "allow" | "explicit_intent" | "none";
  reason: string;
  /** Set only when the classifier failed closed instead of judging the action. */
  failure?: ClassifierFailure;
};

/** One classifier attempt: the raw model response (or error) and parsed decision. */
export type ClassifierIoAttempt = {
  stage: "fast" | "detailed";
  attempt: number;
  response?: {
    stopReason?: string;
    text: string;
    toolCalls?: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }>;
    model: string;
    timestamp: number;
    usage: AssistantMessage["usage"];
    errorMessage?: string;
  };
  parsed?: ClassificationDecision;
  error?: string;
  /** Typed cause when the attempt failed, set by the fallback walk. */
  errorKind?: ClassifierErrorKind;
  /** Delay the provider asked for after a failed attempt. */
  retryAfterMs?: number;
  /** Model that served the attempt (`provider/id`), set by the fallback walk. */
  model?: string;
  durationMs: number;
};

/** Full classifier I/O for an action, surfaced for optional observability logging. */
export type ClassifierIo = {
  model: string;
  reasoning: ClassifierReasoning;
  prompt: {
    system: string;
    context: string;
    action: string;
    fastInstruction: string;
    detailedInstruction: string;
  };
  attempts: ClassifierIoAttempt[];
  durationMs: number;
};

/** Classification decision plus resolved reasoning and the I/O that produced it (when available). */
export type ClassifyResult = ClassificationDecision & {
  reasoning?: ClassifierReasoningLog;
  io?: ClassifierIo;
};

export type SettingsSources = {
  globalSettings?: SettingsFile[];
  projectLocalSettings?: SettingsFile[];
  projectSharedSettings?: SettingsFile[];
  inlineSettings?: SettingsFile[];
};

/** Settings files selected by the last config load. */
export type ConfigSourcePaths = {
  global: string;
  projectLocal: string;
  projectShared: string;
};

export type ConfigLoadResult = {
  config: EffectiveConfig;
  diagnostics: string[];
  /** Absent when config loading is overridden. */
  sources?: ConfigSourcePaths;
};

/** Extra, extension-authored context for the classifier about one action. */
export type ClassifyHints = {
  /** Skip the 0/1 gate and send the action straight to the detailed review. */
  skipFastStage?: boolean;
  /** Static-analysis findings shown to the classifier beside the action. */
  notes?: string[];
};

export type ClassifyAction = (
  ctx: ExtensionContext,
  config: EffectiveConfig,
  action: string,
  loadedContext: string,
  /** Trusted notes from the extension, shown to the classifier next to the transcript. */
  notes?: readonly string[],
  /** Paths the session created earlier; shown to the classifier as provenance evidence. */
  sessionCreatedPaths?: readonly string[],
  /** Extension-authored analysis of this one action; see {@link ClassifyHints}. */
  hints?: ClassifyHints,
) => Promise<ClassifyResult>;
