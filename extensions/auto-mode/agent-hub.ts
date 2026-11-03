/**
 * OMP Agent Hub entry for one auto-mode session.
 *
 * OMP lists `AgentRegistry` refs in `/hub`. Registering a passive `advisor` ref
 * shows what the classifier is doing without making it a peer: advisor refs stay
 * out of IRC rosters, `proc://` listings, and the running-subagent badge, and the
 * hub disables revive and kill for them. Pi has no registry, so everything here
 * is a no-op there.
 */

export const HUB_ID_SUFFIX = "-automode";

/** Longest activity text sent to the hub. The hub truncates again to its column width. */
const HUB_ACTIVITY_MAX_LENGTH = 100;
const CONTROL_OR_SPACE_RUN = /[\s\u0000-\u001f\u007f-\u009f]+/g;

type HubStatus = "running" | "parked";

/** The part of OMP's `AgentRef` this extension reads back. */
type HubRef = { createdAt: number };

/** The part of OMP's `AgentRegistry` this extension uses. */
export type HubRegistry = {
  register(input: {
    id: string;
    displayName: string;
    kind: "advisor";
    parentId: string;
    session: null;
    sessionFile: null;
    status: HubStatus;
    activity?: string;
    createdAt?: number;
  }): HubRef;
  unregister(id: string, expected?: HubRef): boolean;
};

export type HubAgent = {
  kind: string;
  id: string;
  name: string;
};

export type HubEntry = {
  /** A classifier call started. The ref reads `running` until the last pending call finishes. */
  classifyStarted(toolName: string, summary: string): void;
  /** A classifier call finished, whatever the outcome. */
  classifyFinished(): void;
  /** The latest decision for any tier; shown as the ref's activity while it rests. */
  decided(outcome: "allow" | "block", toolName: string, summary: string): void;
  /** Remove the ref, unless a newer session registered the same id. */
  dispose(): void;
};

/** OMP's `ctx.agent`, validated. Absent on Pi. */
export function hubAgentIdentity(ctx: object): HubAgent | undefined {
  const agent = "agent" in ctx ? ctx.agent : undefined;
  if (typeof agent !== "object" || agent === null) {
    return undefined;
  }
  const { kind, id, name } = agent as Record<string, unknown>;
  if (typeof kind !== "string" || typeof id !== "string" || typeof name !== "string") {
    return undefined;
  }
  return { kind, id, name };
}

/** `main-automode` for the main agent, `<spawn id>-automode` for subagents. */
export function hubAgentId(agent: HubAgent): string {
  return `${agent.kind === "main" ? agent.name : agent.id}${HUB_ID_SUFFIX}`;
}

/** OMP's global registry, or undefined when the host has none (Pi). */
export function globalHubRegistry(pi: object): HubRegistry | undefined {
  const omp = "pi" in pi ? pi.pi : undefined;
  if (typeof omp !== "object" || omp === null || !("AgentRegistry" in omp)) {
    return undefined;
  }
  const { AgentRegistry } = omp as { AgentRegistry?: { global?: () => unknown } };
  if (typeof AgentRegistry?.global !== "function") {
    return undefined;
  }
  const registry = AgentRegistry.global() as Partial<HubRegistry> | undefined;
  if (typeof registry?.register !== "function" || typeof registry.unregister !== "function") {
    return undefined;
  }
  return registry as HubRegistry;
}

/** One line, single spaces, no terminal control characters, bounded; tool inputs are model-controlled. */
export function hubActivityText(label: string, toolName: string, summary: string): string {
  const action = summary.startsWith(`${toolName} `) ? summary.slice(toolName.length + 1) : summary;
  const text = `${label} ${toolName} ${action}`.replace(CONTROL_OR_SPACE_RUN, " ").trim();
  return text.length > HUB_ACTIVITY_MAX_LENGTH
    ? `${text.slice(0, HUB_ACTIVITY_MAX_LENGTH - 1)}…`
    : text;
}

export function createHubEntry(
  registry: HubRegistry,
  agent: HubAgent,
): HubEntry {
  const id = hubAgentId(agent);
  let classifying = 0;
  let lastDecision: string | undefined;
  let current: HubRef | undefined;
  // A re-register replaces the ref, which is the only way to change the
  // activity of a ref that is not running: `setActivity` ignores those.
  const publish = (status: HubStatus, activity: string | undefined): void => {
    current = registry.register({
      id,
      displayName: id,
      kind: "advisor",
      parentId: agent.id,
      session: null,
      sessionFile: null,
      status,
      activity,
      createdAt: current?.createdAt,
    });
  };
  publish("parked", undefined);

  return {
    classifyStarted(toolName, summary) {
      classifying += 1;
      publish("running", hubActivityText("classifying", toolName, summary));
    },
    classifyFinished() {
      classifying = Math.max(0, classifying - 1);
      if (classifying === 0) {
        publish("parked", lastDecision);
      }
    },
    decided(outcome, toolName, summary) {
      lastDecision = hubActivityText(outcome === "allow" ? "allowed" : "blocked", toolName, summary);
      if (classifying === 0) {
        publish("parked", lastDecision);
      }
    },
    dispose() {
      registry.unregister(id, current);
    },
  };
}
