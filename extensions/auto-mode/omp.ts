import type { AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { JudgeProbabilities } from "./strategy.ts";

export type ExtensionModelRegistry = ExtensionContext["modelRegistry"];
export type JudgeQuestionId = keyof JudgeProbabilities;

export type JudgeRequest = {
  registry: ExtensionModelRegistry;
  sessionModel?: Model<any>;
  sessionId?: string;
  /** Lets OMP journal the judge's cost on the session when its manager supports it. */
  sessionManager?: unknown;
  state: { context: string; action: string };
  questions: Record<JudgeQuestionId, { instructions: string }>;
  signal?: AbortSignal;
};

export type JudgeOutcome = {
  /** `provider/id` of the judge model that answered. */
  model: string;
  /** Probability that each question's answer is "yes". */
  probabilities: JudgeProbabilities;
  usage: AssistantMessage["usage"];
};

/** OMP-only capabilities. Absent under Pi, where classifier models are `provider/id` only. */
export type OmpBridge = {
  /**
   * Models for an OMP model role in attempt order: the role's own model first,
   * then its configured or built-in fallbacks, which may sit on other providers.
   */
  roleChain(role: string, registry: ExtensionModelRegistry): Model<any>[];
  /**
   * Answer the four policy questions through OMP's `judge` role chain: native
   * judges (TypeSafe Jev and similar) and chat models, never on-device models.
   * Rejects when no candidate can answer.
   */
  judge(request: JudgeRequest): Promise<JudgeOutcome>;
};

let bridge: OmpBridge | undefined;
let loading: Promise<OmpBridge | undefined> | undefined;
let loadError: string | undefined;

/**
 * Load the OMP bridge once. The bridge statically imports OMP internals, so
 * the import fails under Pi and in unit tests; callers then use the Pi path.
 */
export function loadOmpBridge(): Promise<OmpBridge | undefined> {
  loading ??= import("./omp-bridge.ts").then(
    (module) => (bridge = module.ompBridge),
    (error: unknown) => {
      loadError = error instanceof Error ? error.message : String(error);
      return undefined;
    },
  );
  return loading;
}

/** The loaded bridge, for synchronous callers that ran `loadOmpBridge()` first. */
export function getOmpBridge(): OmpBridge | undefined {
  return bridge;
}

/** Why the bridge is unavailable, when its import failed. */
export function ompBridgeLoadError(): string | undefined {
  return loadError;
}

/** Install a fake bridge (or none) in tests. */
export function setOmpBridgeForTesting(next: OmpBridge | undefined): void {
  bridge = next;
  loading = Promise.resolve(next);
  loadError = undefined;
}
