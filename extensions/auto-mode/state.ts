import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { CLASSIFIER_ERROR_HISTORY_LIMIT, DENIAL_HISTORY_LIMIT } from "./constants.ts";
import type {
  AgentIdentity,
  AutoModeState,
  ClassifierErrorRecord,
  DenialRecord,
  EffectiveConfig,
  EnabledSource,
} from "./types.ts";
import { safeJson, truncateMiddle } from "./utils.ts";

/** Session entry holding counters, recent denials, and the `/automode on|off` choice. */
export const STATE_ENTRY = "pi-automode-state";

/**
 * The `/automode on|off` choice for a main session and every subagent it
 * spawns. `value` stays undefined until the user picks one, so the configured
 * `enabled` applies.
 */
export type EnabledOverride = {
  value?: boolean;
  /** Session that created this object. Any other session holding it inherited the choice. */
  owner?: string;
};

// OMP runs the extension factory again for each subagent, so closure state is
// per session and a subagent would otherwise keep blocking after the user ran
// `/automode off` in the main session. Module globals are shared by every
// session in the process. Each session is registered under its session file
// and its session id, because a task subagent's header names its parent by
// file while a `/tan` clone's header names it by id.
const enabledOverrideBySessionKey = new Map<string, EnabledOverride>();

/** The keys under which a session can be named as a parent: its file and its id. */
function sessionKeys(ctx: ExtensionContext): string[] {
  const keys = [
    ctx.sessionManager.getSessionFile?.(),
    ctx.sessionManager.getSessionId?.(),
  ];
  return keys.filter((key): key is string => typeof key === "string" && key !== "");
}

/**
 * Bind a starting session to its agent tree's override. An OMP subagent shares
 * its parent's live object, so toggling in the main session reaches subagents
 * that are already running. Main sessions, forks, and subagents whose parent
 * is not in this process start from their own persisted choice.
 *
 * In-memory (`--no-session`) parents have no session file to link by, so their
 * subagents inherit only when the header names the parent's session id.
 * Otherwise they keep the configured `enabled`, which fails closed.
 */
export function bindEnabledOverride(
  ctx: ExtensionContext,
  persisted: boolean | undefined,
): EnabledOverride {
  // Pi has no subagents and no `agent` field. Forks and `/new` sessions also
  // name a parent session, so only OMP's subagent marker may inherit.
  const agent = "agent" in ctx ? ctx.agent : undefined;
  const isSubagent = typeof agent === "object" && agent !== null &&
    "kind" in agent && agent.kind === "sub";
  const parent = isSubagent
    ? ctx.sessionManager.getHeader?.()?.parentSession
    : undefined;
  const override = (parent ? enabledOverrideBySessionKey.get(parent) : undefined) ??
    { value: persisted, owner: ctx.sessionManager.getSessionId?.() };
  for (const key of sessionKeys(ctx)) {
    enabledOverrideBySessionKey.set(key, override);
  }
  return override;
}

/** Unlink a shutting-down session so later sessions cannot adopt its override. */
export function releaseEnabledOverride(
  ctx: ExtensionContext,
  override: EnabledOverride,
): void {
  for (const key of sessionKeys(ctx)) {
    // Only drop our own binding; another session may have bound this key since.
    if (enabledOverrideBySessionKey.get(key) === override) {
      enabledOverrideBySessionKey.delete(key);
    }
  }
}

export function pushDenial(state: AutoModeState, denial: DenialRecord): void {
  state.recentDenials = [
    ...state.recentDenials.slice(-(DENIAL_HISTORY_LIMIT - 1)),
    denial,
  ];
}

export function pushClassifierError(
  state: AutoModeState,
  error: ClassifierErrorRecord,
): void {
  state.recentClassifierErrors = [
    ...state.recentClassifierErrors.slice(-(CLASSIFIER_ERROR_HISTORY_LIMIT - 1)),
    error,
  ];
}

/**
 * Where the effective `enabled` value came from. `/automode on|off` wins over
 * config. A choice the session did not make itself was inherited from the
 * agent that spawned it.
 */
export function enabledSource(
  config: EffectiveConfig,
  override: EnabledOverride,
  sessionId: string | undefined,
): EnabledSource {
  if (override.value === undefined) return config.enabledSource ?? "default";
  return override.owner !== undefined && override.owner !== sessionId
    ? "parent"
    : "override";
}

/** The host's identity for the running agent. Pi has no `ctx.agent`, so this is OMP-only. */
export function agentIdentity(ctx: ExtensionContext): AgentIdentity | undefined {
  const agent: unknown = "agent" in ctx ? ctx.agent : undefined;
  if (typeof agent !== "object" || agent === null) return undefined;
  const { kind, id, name, depth } = agent as Record<string, unknown>;
  return {
    kind: typeof kind === "string" ? kind : undefined,
    id: typeof id === "string" ? id : undefined,
    name: typeof name === "string" ? name : undefined,
    depth: typeof depth === "number" ? depth : undefined,
  };
}

/** Icon for themes that expose no glyphs, such as Pi's. */
export const FALLBACK_STATUS_ICON = "●";

/** The slice of an OMP theme used to pick the status icon. Pi themes have neither field. */
export type StatusTheme = {
  cmd?: { shield?: string };
  icon?: { auto?: string };
};

/**
 * OMP's `cmd.shield` glyph follows the symbol preset (unicode, nerd). The ascii
 * preset leaves it empty, so fall back to `icon.auto`, then to a plain glyph.
 */
export function statusIcon(theme: StatusTheme | undefined): string {
  return theme?.cmd?.shield || theme?.icon?.auto || FALLBACK_STATUS_ICON;
}

/**
 * One compact segment: `<icon> auto`, `<icon> auto · N blocked`, `<icon> off`,
 * or `<icon> checking…` while a classifier call is in flight. `config` is the
 * effective config, with any `/automode on|off` choice applied.
 */
export function statusLine(
  config: EffectiveConfig,
  state: AutoModeState,
  icon: string,
  checking = false,
): string {
  if (!config.enabled) return `${icon} off`;
  if (checking) return `${icon} checking…`;
  if (state.blockedActions > 0) return `${icon} auto · ${state.blockedActions} blocked`;
  return `${icon} auto`;
}

/** `config` is the effective config, with any `/automode on|off` choice applied. */
export function statusText(
  config: EffectiveConfig,
  state: AutoModeState,
): string {
  return [
    `enabled: ${config.enabled ? "yes" : "no"}`,
    `classifier: ${config.classifierModel ?? "current session model"}`,
    `classifier reasoning: ${config.classifierReasoningLevel ?? "server default"}`,
    `checked actions: ${state.checkedActions}`,
    `blocked actions: ${state.blockedActions}`,
    `classifier allowed: ${state.classifierAllowed}`,
    `classifier denied: ${state.classifierDenied}`,
    `permissions.deny rules: ${config.permissionDeny.length}`,
    `permissions.ask rules: ${config.permissionAsk.length}`,
    `permissions.allow rules: ${config.permissionAllow.length}`,
    `environment entries: ${config.environment.length}`,
    `allow entries: ${config.allow.length}`,
    `soft_deny entries: ${config.softDeny.length}`,
    `hard_deny entries: ${config.hardDeny.length}`,
    `last decision: ${state.lastDecision ?? "none"}`,
    `last decision kind: ${state.lastDecisionKind ?? "none"}`,
    `last reason: ${state.lastReason ?? "none"}`,
  ].join("\n");
}

export function formatDenials(state: AutoModeState): string {
  if (state.recentDenials.length === 0) return "No recent auto-mode denials.";
  return state.recentDenials
    .slice()
    .reverse()
    .map(
      (denial) =>
        `${
          new Date(denial.timestamp).toLocaleTimeString()
        } ${denial.kind} ${denial.toolName}: ${denial.reason}\n  ${
          truncateMiddle(denial.action, 300)
        }`,
    )
    .join("\n\n");
}

export function actionSummary(
  toolName: string,
  input: Record<string, unknown>,
): string {
  return `${toolName} ${safeJson(input, 6000)}`;
}

/** Data written under `STATE_ENTRY`. */
export type PersistedState = AutoModeState & { enabledOverride?: boolean };

export function initialState(): AutoModeState {
  return {
    checkedActions: 0,
    blockedActions: 0,
    classifierAllowed: 0,
    classifierDenied: 0,
    recentDenials: [],
    recentClassifierErrors: [],
  };
}

export function restoreState(ctx: ExtensionContext): {
  state: AutoModeState;
  enabledOverride: boolean | undefined;
} {
  const entries = ctx.sessionManager.getEntries();
  for (let i = entries.length - 1; i >= 0; i -= 1) {
    const entry = entries[i] as {
      type?: string;
      customType?: string;
      data?: Partial<PersistedState>;
    };
    if (
      entry.type !== "custom" ||
      entry.customType !== STATE_ENTRY ||
      !entry.data
    ) {
      continue;
    }
    return {
      state: {
        lastDecision: entry.data.lastDecision,
        lastReason: entry.data.lastReason,
        lastDecisionKind: entry.data.lastDecisionKind,
        checkedActions: entry.data.checkedActions ?? 0,
        blockedActions: entry.data.blockedActions ?? 0,
        classifierAllowed: entry.data.classifierAllowed ?? 0,
        classifierDenied: entry.data.classifierDenied ?? 0,
        recentDenials: Array.isArray(entry.data.recentDenials)
          ? entry.data.recentDenials.slice(-DENIAL_HISTORY_LIMIT)
          : [],
        recentClassifierErrors: Array.isArray(entry.data.recentClassifierErrors)
          ? entry.data.recentClassifierErrors.slice(-CLASSIFIER_ERROR_HISTORY_LIMIT)
          : [],
      },
      enabledOverride: entry.data.enabledOverride,
    };
  }
  return { state: initialState(), enabledOverride: undefined };
}
