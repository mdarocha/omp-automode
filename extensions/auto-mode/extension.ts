import { realpathSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type {
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import {
  classifierReasoningForConfig,
  defaultClassifyAction,
  serializeClassifierAction,
} from "./classifier.ts";
import {
  agentIdOf,
  ASK_DIALOG_TITLE,
  askDialogMessage,
  findAskingAncestor,
  FORWARDED_ASK_TIMEOUT_MS,
  forwardedAskMessage,
  forwardedAskTitle,
  headlessAskNote,
  registerSession,
  releaseSession,
  type SessionRecord,
} from "./ask-forwarding.ts";
import { analyzeBash, type BashAnalysis } from "./bash.ts";
import {
  AUTO_MODE_GUIDANCE,
  DEFAULT_ALLOW,
  DEFAULT_ENVIRONMENT,
  DEFAULT_HARD_DENY,
  DEFAULT_PROTECTED_PATHS,
  DEFAULT_SOFT_DENY,
  PATH_BEARING_TOOLS,
  READ_ONLY_TOOLS,
} from "./constants.ts";
import {
  type GlobalConfigPreparation,
  loadEffectiveConfigWithDiagnostics,
  prepareGlobalConfig,
  writeGlobalClassifierModel,
} from "./config.ts";
import { deterministicHardDeny } from "./hard-deny.ts";
import {
  resolveConfigLocations,
  selectLegacyGlobalConfigPath,
} from "./locations.ts";
import {
  createLogger,
  newDecisionId,
  resolveLogPath,
  type Logger,
} from "./log.ts";
import { formatModelSpec, jevModelId, parseModelSpec } from "./model.ts";
import { promptForClassifierModel } from "./model-selector.ts";
import {
  matchesAllowedToolPatterns,
  matchesDeniedPath,
  matchesToolPattern,
  matchingBashCommandText,
  recursiveSearchMayReachDeniedPath,
} from "./permissions.ts";
import {
  extractInputPath,
  isInside,
  isProtectedPath,
  registerOmpAgentDir,
  resolvePathForPolicy,
  resolveToolInputPath,
} from "./paths.ts";
import {
  actionSummary,
  bindEnabledOverride,
  type EnabledOverride,
  formatDenials,
  initialState,
  type PersistedState,
  pushDenial,
  releaseEnabledOverride,
  restoreState,
  STATE_ENTRY,
  statusLine,
  statusText,
} from "./state.ts";
import {
  ASK_ANSWER_ENTRY,
  askAnswersFromDetails,
  loadedContextFromSystemPromptOptions,
} from "./transcript.ts";
import type {
  AutoModeState,
  ClassifierReasoningLog,
  ClassifyAction,
  ClassifyResult,
  ConfigLoadResult,
  DecisionKind,
  DenialRecord,
  EffectiveConfig,
} from "./types.ts";
import { safeJson, truncateMiddle } from "./utils.ts";

const INSPECT_TOOL = "automode_inspect";
const INSPECTION_ACTIONS = ["status", "config", "defaults", "denials"] as const;
type InspectionAction = (typeof INSPECTION_ACTIONS)[number];

function matchedCommandSummary(command: string | undefined): string | undefined {
  return command ? truncateMiddle(command, 500) : undefined;
}

function canonicalPath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

const EXTENSION_PATH = canonicalPath(fileURLToPath(import.meta.url));
const EXTENSION_ENTRY_PATH = canonicalPath(
  resolve(dirname(EXTENSION_PATH), "../auto-mode.ts"),
);

export function modelVisibleConfigDiagnostics(
  diagnostics: string[],
): string[] {
  return diagnostics.map((diagnostic) =>
    diagnostic.replace(
      /invalid JSON \([\s\S]*\)$/,
      "invalid JSON (parser details omitted from model-visible output)",
    )
  );
}

/**
 * Append the auto-mode guidance to a system prompt, or return `undefined` when
 * the prompt already carries it. Pi passes one string; OMP passes an array of
 * blocks and takes the same shape back. A `/tan` clone starts from its
 * parent's already-extended prompt, so the guidance must not be added twice.
 */
export function withAutoModeGuidance(
  systemPrompt: string | readonly string[],
): string | string[] | undefined {
  if (typeof systemPrompt === "string") {
    return systemPrompt.includes(AUTO_MODE_GUIDANCE)
      ? undefined
      : `${systemPrompt}\n\n${AUTO_MODE_GUIDANCE}`;
  }
  return systemPrompt.some((block) => block.includes(AUTO_MODE_GUIDANCE))
    ? undefined
    : [...systemPrompt, AUTO_MODE_GUIDANCE];
}

function projectIsTrusted(
  ctx: { isProjectTrusted?: () => boolean },
): boolean {
  return typeof ctx.isProjectTrusted === "function"
    ? ctx.isProjectTrusted()
    : false;
}

export type PiAutomodeOptions = {
  /** Override config loading in tests. Runtime code uses Pi-owned disk settings. */
  loadConfig?: (cwd: string, projectTrusted: boolean) => EffectiveConfig;
  /** Override classifier calls in tests so unit tests never need a real LLM/API key. */
  classifyAction?: ClassifyAction;
  /** Override classifier-model persistence in tests. Runtime code writes the active global config. */
  saveClassifierModel?: (classifierModel: string) => void;
  /** Override global config migration and path selection in tests. */
  prepareGlobalConfig?: () => GlobalConfigPreparation;
  /** Override the application-owned observability log root in tests. */
  logRoot?: string;
  /** Override the observability log clock in tests. */
  now?: () => Date;
  /** Override Bash analysis in tests. Runtime code uses unbash. */
  analyzeBash?: typeof analyzeBash;
};

type LogCtx = {
  logger: Logger;
  decisionId: string;
  classifierModel?: string;
  reasoning: ClassifierReasoningLog;
};

/** Append ccusage-compatible usage and optional classifier I/O entries. */
function logClassifierIo(decision: ClassifyResult, log: LogCtx): void {
  if (decision.reasoning) log.reasoning = decision.reasoning;
  if (decision.io) log.reasoning = decision.io.reasoning;
  if (!log.logger.enabled || !decision.io) return;

  for (const attempt of decision.io.attempts) {
    const response = attempt.response;
    if (!response) continue;
    log.logger.append({
      type: "message",
      timestamp: new Date(response.timestamp).toISOString(),
      message: {
        role: "assistant",
        model: response.model,
        usage: response.usage,
      },
    });
  }

  if (!log.logger.classifierIo) return;
  log.logger.append({
    type: "classifier",
    ts: new Date().toISOString(),
    decisionId: log.decisionId,
    model: decision.io.model,
    reasoning: decision.io.reasoning,
    prompt: decision.io.prompt,
    attempts: decision.io.attempts,
    durationMs: decision.io.durationMs,
    parsed: {
      decision: decision.decision,
      tier: decision.tier,
      reason: decision.reason,
    },
  });
}

/** Create a Pi extension instance. Default export uses production dependencies. */
export function createPiAutomode(options: PiAutomodeOptions = {}) {
  const classify = options.classifyAction ?? defaultClassifyAction;
  const now = options.now ?? (() => new Date());

  return function piAutomode(pi: ExtensionAPI) {
    const locations = resolveConfigLocations(pi);
    if (locations.agentDir !== undefined) {
      registerOmpAgentDir(locations.agentDir);
    }
    const logRoot = options.logRoot ?? locations.logRoot;
    const globalConfig = options.prepareGlobalConfig?.() ??
      (options.loadConfig
        ? {
          status: "current" as const,
          activePath: locations.globalConfigPath,
        }
        : prepareGlobalConfig({
          currentPath: locations.globalConfigPath,
          legacyPath: selectLegacyGlobalConfigPath(locations),
        }));
    const loadConfigWithDiagnostics = (
      cwd: string,
      projectTrusted: boolean,
    ): ConfigLoadResult => {
      const result = options.loadConfig
        ? {
          config: options.loadConfig(cwd, projectTrusted),
          diagnostics: [],
        }
        : loadEffectiveConfigWithDiagnostics(
          cwd,
          projectTrusted,
          globalConfig.activePath,
          locations.projectConfigDirs,
        );
      return globalConfig.diagnostic
        ? {
          ...result,
          diagnostics: [...result.diagnostics, globalConfig.diagnostic],
        }
        : result;
    };
    const persistClassifierModel = options.saveClassifierModel ??
      ((classifierModel: string) =>
        writeGlobalClassifierModel(classifierModel, globalConfig.activePath));
    const saveClassifierModel = globalConfig.writeBlockedReason
      ? (_classifierModel: string) => {
        throw new Error(globalConfig.writeBlockedReason);
      }
      : persistClassifierModel;
    let loadResult = loadConfigWithDiagnostics(process.cwd(), false);
    let config: EffectiveConfig = loadResult.config;
    let configDiagnostics: string[] = loadResult.diagnostics;
    let state: AutoModeState = initialState();
    let enabledOverride: EnabledOverride = {};
    let loadedContext = "";
    let globalConfigNoticeShown = false;
    let sessionRecord: SessionRecord | undefined;
    // Dialogs this session has open in an ancestor's UI, closed on shutdown.
    const pendingAsks = new Set<AbortController>();
    // How the per-session state above was set up. OMP never emits
    // `session_start` for `/tan` clones, so a session that gets a hook call
    // first is initialised by `ensureSession` instead.
    let sessionInit: "session-start" | "first-use" | undefined;

    function initialiseSession(
      ctx: ExtensionContext,
      source: "session-start" | "first-use",
    ): void {
      loadResult = loadConfigWithDiagnostics(ctx.cwd, projectIsTrusted(ctx));
      config = loadResult.config;
      configDiagnostics = loadResult.diagnostics;
      const restored = restoreState(ctx);
      state = restored.state;
      enabledOverride = bindEnabledOverride(ctx, restored.enabledOverride);
      // Register on both start paths: a `/tan` clone's subagents also look
      // their ancestors up in this registry.
      sessionRecord = registerSession(ctx);
      sessionInit = source;
    }

    function ensureSession(ctx: ExtensionContext): void {
      if (!sessionInit) {
        initialiseSession(ctx, "first-use");
      }
    }

    function effectiveConfig(): EffectiveConfig {
      return {
        ...config,
        enabled: enabledOverride.value ?? config.enabled,
      };
    }

    function findTool(name: string) {
      try {
        return pi.getAllTools().find((tool) => tool.name === name);
      } catch {
        // OMP leaves runtime actions unwired in sessions that never got
        // `session_start`; a tool that cannot be found is not ours.
        return undefined;
      }
    }

    function ownsInspectionTool(): boolean {
      const tool = findTool(INSPECT_TOOL);
      if (!tool) return false;
      const sourcePath = canonicalPath(tool.sourceInfo.path);
      return sourcePath === EXTENSION_PATH || sourcePath === EXTENSION_ENTRY_PATH;
    }

    function persist(): void {
      // Without `session_start` OMP never wired this session's runtime
      // actions, so `appendEntry` throws; the state stays in memory.
      if (sessionInit === "first-use") {
        return;
      }
      pi.appendEntry(STATE_ENTRY, {
        ...state,
        enabledOverride: enabledOverride.value,
      } satisfies PersistedState);
    }

    function updateUi(ctx: ExtensionContext): void {
      if (!ctx.hasUI) return;
      const cfg = effectiveConfig();
      const text = statusLine(cfg, state);
      ctx.ui.setStatus(
        "pi-automode",
        cfg.enabled
          ? ctx.ui.theme.fg("accent", text)
          : ctx.ui.theme.fg("dim", text),
      );
    }

    function configSourcesReport() {
      return {
        runtime: locations.runtime,
        agentDir: locations.agentDir,
        global: globalConfig.activePath,
        ...loadResult.sources,
      };
    }

    function inspectAutomode(
      action: InspectionAction,
      ctx: ExtensionContext,
    ): unknown {
      const cfg = effectiveConfig();
      if (action === "status") {
        return {
          status: statusText(cfg, {
            ...state,
            lastReason: "omitted from model-visible inspection",
          }),
          state: {
            enabledOverride: enabledOverride.value,
            lastDecision: state.lastDecision,
            checkedActions: state.checkedActions,
            blockedActions: state.blockedActions,
            classifierAllowed: state.classifierAllowed,
            classifierDenied: state.classifierDenied,
          },
        };
      }
      if (action === "config") {
        return {
          config: cfg,
          configSources: configSourcesReport(),
          logFile: resolveLogPath(
            ctx.sessionManager.getSessionFile?.(),
            ctx.sessionManager.getSessionDir?.() ?? "",
            ctx.sessionManager.getSessionId?.() ?? "unknown",
            ctx.cwd,
            logRoot,
            now(),
          ),
          diagnostics: modelVisibleConfigDiagnostics(configDiagnostics),
        };
      }
      if (action === "defaults") {
        return {
          environment: DEFAULT_ENVIRONMENT,
          allow: DEFAULT_ALLOW,
          protectedPaths: DEFAULT_PROTECTED_PATHS,
          soft_deny: DEFAULT_SOFT_DENY,
          hard_deny: DEFAULT_HARD_DENY,
        };
      }
      const denials = state.recentDenials.slice().reverse().map((denial) => ({
        timestamp: denial.timestamp,
        kind: denial.kind,
        toolName: denial.toolName,
      }));
      return {
        summary: denials.length === 0
          ? "No recent auto-mode denials."
          : `${denials.length} recent auto-mode denial(s). Reasons and action payloads are omitted.`,
        denials,
      };
    }

    function blockedToolReason(reason: string): string {
      return `[pi-automode] Action blocked; the tool did not run. ${reason} Do not claim success, rely on effects from this call, or attempt an equivalent workaround. Report the block to the user before continuing with dependent work. Independent work can continue.`;
    }

    function block(
      ctx: ExtensionContext,
      denial: DenialRecord,
      logCtx: LogCtx,
    ): { block: true; reason: string } {
      state.blockedActions += 1;
      state.lastDecision = "block";
      state.lastReason = denial.reason;
      pushDenial(state, denial);
      persist();
      updateUi(ctx);
      if (logCtx.logger.enabled) {
        logCtx.logger.append({
          type: "decision",
          ts: new Date().toISOString(),
          decisionId: logCtx.decisionId,
          sessionId: ctx.sessionManager.getSessionId?.(),
          cwd: ctx.cwd,
          tool: denial.toolName,
          summary: denial.action,
          kind: denial.kind,
          outcome: "block",
          reason: denial.reason,
          classifierModel: logCtx.classifierModel,
          reasoning: logCtx.reasoning,
        });
      }
      if (ctx.hasUI) {
        ctx.ui.notify(
          `Auto mode blocked ${denial.toolName}: ${denial.reason}`,
          "warning",
        );
      }
      return {
        block: true,
        reason: blockedToolReason(denial.reason),
      };
    }

    function allow(
      ctx: ExtensionContext,
      kind: DecisionKind,
      reason: string,
      toolName: string,
      summary: string,
      logCtx: LogCtx,
    ): undefined {
      state.lastDecision = "allow";
      state.lastReason = reason;
      persist();
      updateUi(ctx);
      if (logCtx.logger.enabled) {
        logCtx.logger.append({
          type: "decision",
          ts: new Date().toISOString(),
          decisionId: logCtx.decisionId,
          sessionId: ctx.sessionManager.getSessionId?.(),
          cwd: ctx.cwd,
          tool: toolName,
          summary,
          kind,
          outcome: "allow",
          reason,
          classifierModel: logCtx.classifierModel,
          reasoning: logCtx.reasoning,
        });
      }
      return undefined;
    }

    pi.on("session_start", (_event, ctx) => {
      initialiseSession(ctx, "session-start");
      if (
        ctx.hasUI &&
        globalConfig.notification &&
        !globalConfigNoticeShown
      ) {
        ctx.ui.notify(
          globalConfig.notification,
          globalConfig.status === "migrated" ? "info" : "warning",
        );
        globalConfigNoticeShown = true;
      }
      updateUi(ctx);
    });

    pi.on("session_shutdown", (_event, ctx) => {
      releaseEnabledOverride(ctx, enabledOverride);
      sessionInit = undefined;
      if (sessionRecord) {
        releaseSession(ctx, sessionRecord);
      }
      for (const pending of pendingAsks) {
        pending.abort();
      }
    });

    pi.on("before_agent_start", (event, ctx) => {
      ensureSession(ctx);
      const cfg = effectiveConfig();
      if (!cfg.enabled) return undefined;
      loadedContext = loadedContextFromSystemPromptOptions(
        event.systemPromptOptions,
      );
      const guided = withAutoModeGuidance(event.systemPrompt);
      if (guided === undefined) return undefined;
      // OMP accepts back the block array it passes in; Pi's typings only
      // know the string form.
      return { systemPrompt: guided as string };
    });

    pi.on("tool_result", (event) => {
      if (event.toolName !== "ask" || event.isError || event.parentToolCallId) return undefined;
      // Only OMP's built-in ask shows the question to the user. A same-named
      // extension tool could invent an answer, so it never counts as consent.
      const sourceInfo: { path: string; source?: string } | undefined = pi.getAllTools()
        .find(({ name }) => name === "ask")?.sourceInfo;
      if (sourceInfo?.source !== "builtin" || sourceInfo.path !== "<builtin:ask>") return undefined;
      const answers = askAnswersFromDetails(event.details);
      if (answers.length > 0) {
        pi.appendEntry(ASK_ANSWER_ENTRY, { toolCallId: event.toolCallId, answers });
      }
      return undefined;
    });

    pi.on("tool_call", async (event, ctx) => {
      // Enforcement order:
      // 1. permission deny/ask rules,
      // 2. deterministic hard-deny checks that never consult the model,
      // 3. extension-owned read-only inspection tool,
      // 4. deterministic path denials,
      // 5. accepted ask rules force classifier review and skip all allow tiers,
      // 6. inside-CWD, permissions.allow, and read-only allow tiers,
      // 7. classifier for every remaining action, fail-closed on setup/parse errors.
      ensureSession(ctx);
      const cfg = effectiveConfig();
      if (!cfg.enabled) return undefined;

      const input = event.input as Record<string, unknown>;
      const summary = actionSummary(event.toolName, input);
      const logCtx: LogCtx = {
        logger: createLogger({
          enabled: cfg.log.enabled,
          classifierIo: cfg.log.classifierIo,
          sessionFile: ctx.sessionManager.getSessionFile?.(),
          sessionDir: ctx.sessionManager.getSessionDir?.() ?? "",
          sessionCwd: ctx.cwd,
          sessionId: ctx.sessionManager.getSessionId?.() ?? "unknown",
          logRoot,
          now: now(),
        }),
        decisionId: newDecisionId(),
        classifierModel: cfg.classifierModel,
        reasoning: classifierReasoningForConfig(cfg.classifierReasoningLevel),
      };

      if (ctx.signal?.aborted) {
        state.checkedActions += 1;
        return block(ctx, {
          timestamp: Date.now(),
          toolName: event.toolName,
          reason: "Cancelled",
          action: summary,
          kind: "setup",
        }, logCtx);
      }

      const isOwnedInspection = event.toolName === INSPECT_TOOL &&
        ownsInspectionTool();
      let bashAnalysis: BashAnalysis | undefined;
      if (event.toolName === "bash") {
        const source = typeof input.command === "string" ? input.command : "";
        try {
          bashAnalysis = (options.analyzeBash ?? analyzeBash)(source);
        } catch (error) {
          bashAnalysis = {
            source,
            commands: [],
            redirects: [],
            writeRedirectTargets: [],
            structure: [],
            allowStructureSafe: false,
            errors: [{
              message: `Bash analysis failed: ${
                error instanceof Error ? error.message : String(error)
              }`,
            }],
          };
        }
      }
      if (!isOwnedInspection) state.checkedActions += 1;

      for (const pattern of cfg.permissionDeny) {
        if (
          matchesToolPattern(
            pattern,
            event.toolName,
            input,
            ctx.cwd,
            "match",
            bashAnalysis,
          )
        ) {
          const matchedCommand = matchedCommandSummary(
            matchingBashCommandText(pattern, bashAnalysis),
          );
          if (isOwnedInspection) state.checkedActions += 1;
          return block(ctx, {
            timestamp: Date.now(),
            toolName: event.toolName,
            reason: `Blocked by permissions.deny: ${pattern.raw}${
              matchedCommand ? `; matched command: ${matchedCommand}` : ""
            }`,
            action: summary,
            kind: "permissions.deny",
          }, logCtx);
        }
      }

      let askRequiresClassifier = false;
      const classifierNotes: string[] = [];
      for (const pattern of cfg.permissionAsk) {
        if (
          !matchesToolPattern(
            pattern,
            event.toolName,
            input,
            ctx.cwd,
            "match",
            bashAnalysis,
          )
        ) {
          continue;
        }
        const matchedCommand = matchedCommandSummary(
          matchingBashCommandText(pattern, bashAnalysis),
        );
        const blockAsk = (reason: string) => {
          if (isOwnedInspection) state.checkedActions += 1;
          return block(ctx, {
            timestamp: Date.now(),
            toolName: event.toolName,
            reason,
            action: summary,
            kind: "permissions.ask",
          }, logCtx);
        };
        let allowed: boolean;
        let timedOut = false;
        if (ctx.hasUI) {
          allowed = await ctx.ui.confirm(ASK_DIALOG_TITLE, askDialogMessage(pattern.raw, summary), {
            signal: ctx.signal,
          });
        } else if (cfg.headlessAsk === "classifier") {
          askRequiresClassifier = true;
          classifierNotes.push(headlessAskNote(pattern.raw));
          continue;
        } else {
          const ancestor = cfg.headlessAsk === "parent"
            ? findAskingAncestor(ctx)
            : undefined;
          if (!ancestor) {
            return blockAsk(
              `Matched permissions.ask (${pattern.raw})${
                matchedCommand ? ` for command: ${matchedCommand}` : ""
              } but no UI is available${
                cfg.headlessAsk === "parent" ? " here or in a parent session" : ""
              }`,
            );
          }
          const dialog = new AbortController();
          pendingAsks.add(dialog);
          const deadline = setTimeout(() => {
            timedOut = true;
            dialog.abort();
          }, FORWARDED_ASK_TIMEOUT_MS);
          try {
            allowed = await ancestor.ui.confirm(
              forwardedAskTitle(agentIdOf(ctx)),
              forwardedAskMessage(pattern.raw, summary),
              {
                signal: ctx.signal
                  ? AbortSignal.any([ctx.signal, dialog.signal])
                  : dialog.signal,
              },
            );
          } catch (error) {
            // Fail closed: an ancestor whose UI is gone cannot approve.
            return blockAsk(
              `Could not ask the parent session about permissions.ask (${pattern.raw}): ${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          } finally {
            clearTimeout(deadline);
            pendingAsks.delete(dialog);
          }
        }
        if (!allowed) {
          return blockAsk(
            `${
              timedOut
                ? `No answer from the parent session within ${FORWARDED_ASK_TIMEOUT_MS / 1000}s for permissions.ask`
                : "Declined permissions.ask"
            }: ${pattern.raw}${
              matchedCommand ? `; matched command: ${matchedCommand}` : ""
            }`,
          );
        }
        askRequiresClassifier = true;
      }

      const deterministicReason = deterministicHardDeny(
        event.toolName,
        input,
        ctx.cwd,
        bashAnalysis,
      );
      if (deterministicReason) {
        if (isOwnedInspection) state.checkedActions += 1;
        return block(ctx, {
          timestamp: Date.now(),
          toolName: event.toolName,
          reason: deterministicReason,
          action: summary,
          kind: "deterministic-hard-deny",
        }, logCtx);
      }

      if (isOwnedInspection && !askRequiresClassifier) return undefined;
      if (isOwnedInspection) state.checkedActions += 1;

      // Deterministic path gate for file tools.
      //
      // `deniedPaths` always applies: a matching path is hard-denied before any
      // classifier or fast path, so secrets and system dirs never reach the
      // model. `allowInsideWorkingDirectory` adds a deterministic silent-allow
      // tier for file tools whose resolved path is inside the working
      // directory, and routes outside-CWD file access to the classifier
      // (bypassing the read-only fast path so reads outside the tree are
      // reviewed too).
      //
      // The gate is skipped entirely when both features are off, so the
      // default configuration costs no extra filesystem calls.
      let readOnlyFastPath =
        !askRequiresClassifier &&
        !cfg.classifyReadOnlyTools &&
        READ_ONLY_TOOLS.has(event.toolName);
      if (
        (cfg.deniedPaths.length > 0 || cfg.allowInsideWorkingDirectory) &&
        PATH_BEARING_TOOLS.has(event.toolName)
      ) {
        const inputPath = extractInputPath(event.toolName, input);
        if (inputPath !== undefined) {
          const resolved =
            resolveToolInputPath(event.toolName, ctx.cwd, inputPath) ??
            inputPath;
          const policyPath = resolvePathForPolicy(resolved) ?? resolved;
          const denied =
            cfg.deniedPaths.length > 0 &&
            (matchesDeniedPath(resolved, cfg.deniedPaths) ||
              matchesDeniedPath(policyPath, cfg.deniedPaths));
          if (denied) {
            return block(ctx, {
              timestamp: Date.now(),
              toolName: event.toolName,
              reason: `Path denied by policy: ${policyPath}`,
              action: summary,
              kind: "deterministic-path-deny",
            }, logCtx);
          }
          let recursiveSearch =
            event.toolName === "grep" || event.toolName === "find";
          if (recursiveSearch) {
            try {
              recursiveSearch = statSync(policyPath).isDirectory();
            } catch {
              // A missing search root will fail in the tool. Treat it as a
              // directory here so a denied scope cannot fail open in a race.
            }
          }
          const deniedSearchScope =
            recursiveSearch &&
            cfg.deniedPaths.length > 0 &&
            (recursiveSearchMayReachDeniedPath(resolved, cfg.deniedPaths) ||
              recursiveSearchMayReachDeniedPath(
                policyPath,
                cfg.deniedPaths,
              ));
          if (deniedSearchScope) {
            return block(ctx, {
              timestamp: Date.now(),
              toolName: event.toolName,
              reason: `Search scope can contain a path denied by policy: ${policyPath}`,
              action: summary,
              kind: "deterministic-path-deny",
            }, logCtx);
          }
          if (cfg.allowInsideWorkingDirectory) {
            const policyCwd = resolvePathForPolicy(ctx.cwd) ?? ctx.cwd;
            if (isInside(policyPath, policyCwd)) {
              // Protected in-tree writes and accepted ask rules must still
              // reach the classifier. They cannot use the inside-CWD tier.
              const protectedWrite =
                (event.toolName === "write" || event.toolName === "edit") &&
                isProtectedPath(policyPath, policyCwd, cfg.protectedPaths);
              if (!askRequiresClassifier && !protectedWrite) {
                return allow(
                  ctx,
                  "inside-working-directory",
                  `Path inside working directory: ${policyPath}`,
                  event.toolName,
                  summary,
                  logCtx,
                );
              }
            }
            // Outside the working directory, protected writes, and accepted
            // ask rules must not use the read-only fast path.
            readOnlyFastPath = false;
          }
        }
      }

      // Deterministic allow tier. It runs after every deterministic denial.
      // Accepted ask rules skip this tier and always reach the classifier.
      if (!askRequiresClassifier) {
        if (
          matchesAllowedToolPatterns(
            cfg.permissionAllow,
            event.toolName,
            input,
            ctx.cwd,
            bashAnalysis,
          )
        ) {
          // A protected-path write/edit is never covered by permissions.allow;
          // it stays on the classifier path (same rule as the inside-CWD tier).
          let protectedWrite = false;
          if (event.toolName === "write" || event.toolName === "edit") {
            const inputPath = extractInputPath(event.toolName, input);
            const resolved = inputPath === undefined
              ? undefined
              : resolveToolInputPath(event.toolName, ctx.cwd, inputPath) ??
                inputPath;
            if (
              resolved !== undefined &&
              isProtectedPath(resolved, ctx.cwd, cfg.protectedPaths)
            ) {
              protectedWrite = true;
            }
          }
          if (!protectedWrite) {
            return allow(
              ctx,
              "permissions.allow",
              "Allowed by permissions.allow",
              event.toolName,
              summary,
              logCtx,
            );
          }
        }
      }

      if (readOnlyFastPath) {
        return allow(
          ctx,
          "read-only",
          `Read-only built-in tool: ${event.toolName}`,
          event.toolName,
          summary,
          logCtx,
        );
      }

      const decision = await classify(
        ctx,
        cfg,
        serializeClassifierAction(event.toolName, input),
        loadedContext,
        classifierNotes,
      );
      logClassifierIo(decision, logCtx);
      if (decision.decision === "allow") {
        state.classifierAllowed += 1;
        return allow(
          ctx,
          "classifier",
          decision.reason,
          event.toolName,
          summary,
          logCtx,
        );
      }

      state.classifierDenied += 1;
      return block(ctx, {
        timestamp: Date.now(),
        toolName: event.toolName,
        reason: decision.reason,
        action: summary,
        kind: "classifier",
      }, logCtx);
    });

    pi.registerTool({
      name: INSPECT_TOOL,
      label: "Inspect Auto Mode",
      description:
        "Inspect the active pi-automode status, effective config, built-in defaults, or recent denial metadata. This tool is read-only and cannot enable, disable, reload, reset, or reconfigure auto mode. Its output is sent to the current model; denial reasons and action payloads are omitted.",
      promptSnippet:
        "Inspect active pi-automode state and diagnostic information without changing it",
      parameters: Type.Object({
        action: StringEnum(INSPECTION_ACTIONS, {
          description: "The read-only auto-mode view to return",
        }),
      }),
      async execute(_toolCallId, params, signal, _onUpdate, ctx) {
        if (signal?.aborted) throw new Error("Auto-mode inspection cancelled");
        const result = inspectAutomode(params.action, ctx);
        return {
          content: [{ type: "text", text: safeJson(result, 16000) }],
          details: result,
        };
      },
    });

    async function handleAutomodeCommand(
      args: string,
      ctx: ExtensionCommandContext,
    ): Promise<void> {
      const [command = "status", ...rest] = args
        .trim()
        .split(/\s+/)
        .filter(Boolean);
      const remainder = rest.join(" ").trim();

      if (command === "status") {
        ctx.ui.notify(statusText(effectiveConfig(), state), "info");
        return;
      }
      if (command === "on") {
        enabledOverride.value = true;
        persist();
        updateUi(ctx);
        ctx.ui.notify("pi-automode enabled for this session and its subagents", "info");
        return;
      }
      if (command === "off") {
        enabledOverride.value = false;
        persist();
        updateUi(ctx);
        ctx.ui.notify("pi-automode disabled for this session and its subagents", "warning");
        return;
      }
      if (command === "reload") {
        loadResult = loadConfigWithDiagnostics(
          ctx.cwd,
          projectIsTrusted(ctx),
        );
        config = loadResult.config;
        configDiagnostics = loadResult.diagnostics;
        persist();
        updateUi(ctx);
        ctx.ui.notify(
          "pi-automode config reloaded",
          configDiagnostics.length > 0 ? "warning" : "info",
        );
        return;
      }
      if (command === "reset") {
        state = initialState();
        persist();
        updateUi(ctx);
        ctx.ui.notify("pi-automode counters reset", "info");
        return;
      }
      if (command === "defaults") {
        ctx.ui.notify(
          safeJson(
            {
              environment: DEFAULT_ENVIRONMENT,
              allow: DEFAULT_ALLOW,
              protectedPaths: DEFAULT_PROTECTED_PATHS,
              soft_deny: DEFAULT_SOFT_DENY,
              hard_deny: DEFAULT_HARD_DENY,
            },
            12000,
          ),
          "info",
        );
        return;
      }
      if (command === "config") {
        const logFile = resolveLogPath(
          ctx.sessionManager.getSessionFile?.(),
          ctx.sessionManager.getSessionDir?.() ?? "",
          ctx.sessionManager.getSessionId?.() ?? "unknown",
          ctx.cwd,
          logRoot,
          now(),
        );
        ctx.ui.notify(
          safeJson(
            {
              config: effectiveConfig(),
              configSources: configSourcesReport(),
              logFile,
              diagnostics: configDiagnostics,
            },
            16000,
          ),
          configDiagnostics.length > 0 ? "warning" : "info",
        );
        return;
      }
      if (command === "denials") {
        ctx.ui.notify(
          formatDenials(state),
          state.recentDenials.length > 0 ? "warning" : "info",
        );
        return;
      }
      if (command === "model") {
        const selected = remainder || await promptForClassifierModel(
          ctx,
          effectiveConfig().classifierModel,
        );
        if (!selected) {
          ctx.ui.notify("Classifier model unchanged", "info");
          return;
        }
        let modelSpec: string;
        if (jevModelId(selected)) {
          if (!process.env.TYPESAFE_API_KEY?.trim()) {
            ctx.ui.notify("Set TYPESAFE_API_KEY before selecting Jev.", "error");
            return;
          }
          modelSpec = selected;
        } else {
          const parsed = parseModelSpec(selected);
          const model = parsed
            ? ctx.modelRegistry.find(parsed.provider, parsed.id)
            : undefined;
          if (!model) {
            ctx.ui.notify(`Model not found: ${selected}`, "error");
            return;
          }
          const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
          if (!auth.ok) {
            ctx.ui.notify(auth.error, "error");
            return;
          }
          modelSpec = formatModelSpec(model);
        }
        try {
          saveClassifierModel(modelSpec);
        } catch (error) {
          ctx.ui.notify(
            `Failed to save classifier model: ${
              error instanceof Error ? error.message : String(error)
            }`,
            "error",
          );
          return;
        }
        loadResult = loadConfigWithDiagnostics(
          ctx.cwd,
          projectIsTrusted(ctx),
        );
        config = loadResult.config;
        configDiagnostics = loadResult.diagnostics;
        persist();
        updateUi(ctx);
        const active = effectiveConfig().classifierModel ??
          "current session model";
        ctx.ui.notify(
          active === modelSpec
            ? `pi-automode classifier saved globally: ${modelSpec}`
            : `pi-automode classifier saved globally: ${modelSpec}; current config uses ${active}`,
          "info",
        );
        return;
      }

      ctx.ui.notify(
        "Usage: /automode [status|on|off|reload|reset|defaults|config|denials|model [provider/id]]",
        "error",
      );
    }

    pi.registerCommand("automode", {
      description:
        "Control pi-automode: status, on, off, reload, reset, defaults, config, denials, model",
      handler: handleAutomodeCommand,
    });
  };
}
