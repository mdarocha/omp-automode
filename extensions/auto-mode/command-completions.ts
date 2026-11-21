import type { AutocompleteItem } from "@earendil-works/pi-tui";

/** `/automode` subcommands in the order the completion menu shows them. */
export const AUTOMODE_SUBCOMMANDS: readonly AutocompleteItem[] = [
  { value: "status", label: "status", description: "Show state, counters, and the classifier" },
  { value: "on", label: "on", description: "Enable auto mode for this session and its subagents" },
  { value: "off", label: "off", description: "Disable auto mode for this session and its subagents" },
  { value: "settings", label: "settings", description: "Open the settings menu" },
  { value: "model", label: "model", description: "Choose the classifier model or role" },
  { value: "config", label: "config", description: "Show the effective config and its sources" },
  { value: "denials", label: "denials", description: "Show recent denials" },
  { value: "defaults", label: "defaults", description: "Show the built-in rules" },
  { value: "reload", label: "reload", description: "Reload config and clear classifier cooldowns" },
  { value: "reset", label: "reset", description: "Reset counters and denial history" },
];

/** A `/automode model` argument offered as a completion. */
export type ModelChoice = { selector: string; description?: string };

/**
 * Completions for the text after `/automode `. OMP and Pi replace the whole
 * argument text with the chosen item's `value`, so second-level items carry
 * the subcommand too (`model @smol`).
 */
export async function automodeCompletions(
  argumentPrefix: string,
  modelChoices: () => Promise<readonly ModelChoice[]>,
): Promise<AutocompleteItem[] | null> {
  const text = argumentPrefix.trimStart().toLowerCase();
  const space = text.search(/\s/);

  if (space === -1) {
    const matches = AUTOMODE_SUBCOMMANDS.filter((item) => item.value.startsWith(text));
    return matches.length > 0 ? matches : null;
  }

  if (text.slice(0, space) !== "model") {
    return null;
  }
  const query = text.slice(space).trimStart();
  if (/\s/.test(query)) {
    return null;
  }
  const matches = (await modelChoices())
    .filter(({ selector }) => selector.toLowerCase().includes(query))
    .map(({ selector, description }): AutocompleteItem => ({
      value: `model ${selector}`,
      label: selector,
      ...(description === undefined ? {} : { description }),
    }));
  return matches.length > 0 ? matches : null;
}
