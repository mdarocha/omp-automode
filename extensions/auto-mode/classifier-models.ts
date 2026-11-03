import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { DEFAULT_OMP_CLASSIFIER_SELECTOR } from "./constants.ts";
import {
  formatModelSpec,
  parseClassifierSelector,
  ROLE_SELECTOR_PREFIX,
} from "./model.ts";
import { ompBridgeLoadError, type OmpBridge } from "./omp.ts";
import type { EffectiveConfig } from "./types.ts";

export type ClassifierModels = {
  /** The selector being resolved: the configured value, or OMP's default when none is set. */
  selector?: string;
  /** Candidate models in attempt order. */
  models: Model<any>[];
  /** Why `models` is empty, when the selector could not be resolved. */
  problem?: string;
};

type ModelQueryContext = {
  models?: { resolve?: (spec: string) => Model<any> | undefined };
};

function roleName(selector: string): string {
  return selector.slice(ROLE_SELECTOR_PREFIX.length);
}

/**
 * Resolve `classifierModel` to candidate models in attempt order.
 *
 * Under OMP a role selector (`@smol`) expands to that role's chain, and an unset
 * value means `@smol`; if that role has no available model the session model
 * is used, as before roles were supported. Pi has no roles: an unset value means
 * the session model and anything else is a `provider/id` pair.
 */
export function resolveClassifierModels(
  ctx: ExtensionContext,
  config: Pick<EffectiveConfig, "classifierModel">,
  bridge: OmpBridge | undefined,
): ClassifierModels {
  const configured = config.classifierModel;
  if (configured === undefined) {
    const sessionModels = ctx.model ? [ctx.model] : [];
    if (!bridge) {
      return { models: sessionModels };
    }
    const chain = bridge.roleChain(
      roleName(DEFAULT_OMP_CLASSIFIER_SELECTOR),
      ctx.modelRegistry,
    );
    return {
      selector: DEFAULT_OMP_CLASSIFIER_SELECTOR,
      models: chain.length > 0 ? chain : sessionModels,
    };
  }

  const selector = parseClassifierSelector(configured);
  if (selector?.kind === "role") {
    if (!bridge) {
      const reason = ompBridgeLoadError();
      return {
        selector: configured,
        models: [],
        problem: `${configured} needs OMP model roles${
          reason ? ` (${reason})` : ""
        }; use provider/id`,
      };
    }
    const models = bridge.roleChain(selector.role, ctx.modelRegistry);
    return models.length > 0
      ? { selector: configured, models }
      : {
        selector: configured,
        models,
        problem: `${configured} resolves to no available model`,
      };
  }
  if (selector?.kind === "model") {
    const model = ctx.modelRegistry.find(selector.provider, selector.id) ??
      (ctx as ModelQueryContext).models?.resolve?.(configured);
    return model
      ? { selector: configured, models: [model] }
      : {
        selector: configured,
        models: [],
        problem: `model ${configured} not found`,
      };
  }
  return { selector: configured, models: [] };
}

/** One-line description of the classifier for status and diagnostics. */
export function describeClassifierModel(
  ctx: ExtensionContext,
  config: Pick<EffectiveConfig, "classifierModel">,
  bridge: OmpBridge | undefined,
): string {
  const configured = config.classifierModel;
  if (configured !== undefined && parseClassifierSelector(configured)?.kind !== "role") {
    return configured;
  }
  const resolved = resolveClassifierModels(ctx, config, bridge);
  if (resolved.selector === undefined) {
    return "current session model";
  }
  const [first, ...fallbacks] = resolved.models;
  if (!first) {
    return `${resolved.selector} (no available model)`;
  }
  const label = configured === undefined
    ? `${resolved.selector} (default)`
    : resolved.selector;
  const extra = fallbacks.length === 0
    ? ""
    : ` +${fallbacks.length} fallback${fallbacks.length === 1 ? "" : "s"}`;
  return `${label} → ${formatModelSpec(first)}${extra}`;
}
