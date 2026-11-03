import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";

export type ExtensionModelRegistry = ExtensionContext["modelRegistry"];

/** OMP-only capabilities. Absent under Pi, where classifier models are `provider/id` only. */
export type OmpBridge = {
  /**
   * Models for an OMP model role in attempt order: the role's own model first,
   * then its configured or built-in fallbacks, which may sit on other providers.
   */
  roleChain(role: string, registry: ExtensionModelRegistry): Model<any>[];
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
