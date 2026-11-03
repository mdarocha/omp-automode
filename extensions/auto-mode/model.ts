import type { Model } from "@earendil-works/pi-ai";

export function parseModelSpec(
  spec: string,
): { provider: string; id: string } | undefined {
  const slash = spec.indexOf("/");
  if (slash <= 0 || slash >= spec.length - 1) return undefined;
  return { provider: spec.slice(0, slash), id: spec.slice(slash + 1) };
}

export function formatModelSpec(model: Model<any>): string {
  return `${model.provider}/${model.id}`;
}

export function jevModelId(spec: string | undefined): string | undefined {
  return spec?.match(/^typesafe\/(jev-[a-zA-Z0-9][a-zA-Z0-9._-]*)$/)?.[1];
}

/** Prefix OMP uses for model role aliases such as `@smol`. */
export const ROLE_SELECTOR_PREFIX = "@";
const ROLE_NAME_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export type ClassifierSelector =
  | { kind: "role"; role: string }
  | { kind: "jev"; id: string }
  | { kind: "model"; provider: string; id: string };

/**
 * Parse a `classifierModel` value: an OMP role alias (`@smol`), a TypeSafe Jev
 * model (`typesafe/jev-*`), or a `provider/id` pair. Anything else is invalid.
 */
export function parseClassifierSelector(
  spec: string,
): ClassifierSelector | undefined {
  if (spec.startsWith(ROLE_SELECTOR_PREFIX)) {
    const role = spec.slice(ROLE_SELECTOR_PREFIX.length);
    return ROLE_NAME_PATTERN.test(role) ? { kind: "role", role } : undefined;
  }
  const jevId = jevModelId(spec);
  if (jevId) return { kind: "jev", id: jevId };
  const parsed = parseModelSpec(spec);
  return parsed && { kind: "model", ...parsed };
}
