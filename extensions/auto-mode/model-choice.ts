import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { resolveClassifierModels } from "./classifier-models.ts";
import {
  CURRENT_OPTION_MARKER,
  DEFAULT_OMP_CLASSIFIER_SELECTOR,
} from "./constants.ts";
import {
  formatModelSpec,
  jevModelId,
  parseClassifierSelector,
  parseModelSpec,
  ROLE_SELECTOR_PREFIX,
} from "./model.ts";
import { jevSelectorChoices, promptForClassifierModel } from "./model-selector.ts";
import { loadOmpBridge } from "./omp.ts";

const BROWSE_MODELS_OPTION = "Browse all models…";

/** A classifier selection that passed validation, or why it did not. */
export type ClassifierSelection = { spec: string } | { error: string };

/**
 * Ask the user for a classifier model. Under OMP a first list offers the model
 * roles, because OMP's select-only model picker lists models only, and leads to
 * OMP's native picker for a specific model. Pi shows its own model list.
 * Resolves to a `provider/id`, `@role`, or `typesafe/jev-*` selector, or
 * undefined when the user dismisses the prompt.
 */
export async function chooseClassifierModel(
  ctx: ExtensionContext,
  current?: string,
): Promise<string | undefined> {
  if (!ctx.hasUI) {
    return undefined;
  }
  const bridge = await loadOmpBridge();
  if (!bridge) {
    return promptForClassifierModel(ctx, current);
  }

  const active = current ?? DEFAULT_OMP_CLASSIFIER_SELECTOR;
  const selectors: Record<string, string> = {};
  const addChoice = (selector: string, text: string): void => {
    selectors[selector === active ? `${text}${CURRENT_OPTION_MARKER}` : text] = selector;
  };
  for (const role of bridge.roleNames()) {
    const [first] = bridge.roleChain(role, ctx.modelRegistry);
    if (first) {
      const selector = `${ROLE_SELECTOR_PREFIX}${role}`;
      addChoice(selector, `${selector} → ${formatModelSpec(first)}`);
    }
  }
  for (const spec of jevSelectorChoices(current)) {
    addChoice(spec, `${spec} (TypeSafe Jev)`);
  }

  const picked = await ctx.ui.select(`Classifier model (now ${active})`, [
    ...Object.keys(selectors),
    BROWSE_MODELS_OPTION,
  ]);
  if (picked === undefined) {
    return undefined;
  }
  if (picked !== BROWSE_MODELS_OPTION) {
    return selectors[picked];
  }
  try {
    return await bridge.pickModel(
      ctx,
      parseClassifierSelector(active)?.kind === "model" ? active : undefined,
    );
  } catch (error) {
    ctx.ui.notify(
      `OMP model picker unavailable (${
        error instanceof Error ? error.message : String(error)
      }); showing the plain model list`,
      "warning",
    );
    return promptForClassifierModel(ctx, current);
  }
}

/**
 * Check that a classifier selector can run: a Jev model needs its API key, a
 * role must resolve to a model, and a model must exist and have credentials.
 * Resolves to the canonical value to save.
 */
export async function validateClassifierSelection(
  ctx: ExtensionContext,
  selected: string,
): Promise<ClassifierSelection> {
  if (jevModelId(selected)) {
    return process.env.TYPESAFE_API_KEY?.trim()
      ? { spec: selected }
      : { error: "Set TYPESAFE_API_KEY before selecting Jev." };
  }
  if (parseClassifierSelector(selected)?.kind === "role") {
    const resolved = resolveClassifierModels(
      ctx,
      { classifierModel: selected },
      await loadOmpBridge(),
    );
    return resolved.models.length === 0
      ? { error: resolved.problem ?? `${selected} resolves to no available model` }
      : { spec: selected };
  }
  const parsed = parseModelSpec(selected);
  const model = parsed
    ? ctx.modelRegistry.find(parsed.provider, parsed.id)
    : undefined;
  if (!model) {
    return { error: `Model not found: ${selected}` };
  }
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
  return auth.ok ? { spec: formatModelSpec(model) } : { error: auth.error };
}
