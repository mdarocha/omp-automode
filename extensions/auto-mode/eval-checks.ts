import type { BashAnalysis, analyzeBash } from "./bash.ts";
import { EVAL_TOOL } from "./constants.ts";
import { analyzeEval, describeEvalAnalysis } from "./eval-analysis.ts";
import { deterministicHardDeny } from "./hard-deny.ts";
import { matchesAllowedToolPatterns, matchesToolPattern } from "./permissions.ts";
import type { ClassifyHints, ToolPattern } from "./types.ts";

/** A shell command recovered from eval code, with its bash analysis. */
export type EmbeddedBashCommand = {
  command: string;
  origin: string;
  analysis: BashAnalysis;
};

/** Everything the `tool_call` hook needs to treat an `eval` call like the shell commands it contains. */
export type EvalChecks = {
  embedded: EmbeddedBashCommand[];
  /** Why the eval cannot be fully understood statically; empty means every command was extracted. */
  opaqueReasons: string[];
  /** Extension-authored lines for the classifier. */
  notes: string[];
};

/** A permission-rule subject: the tool call itself or a command embedded in it. */
export type PermissionTarget = {
  toolName: string;
  input: Record<string, unknown>;
  bashAnalysis?: BashAnalysis;
  /** Set for commands recovered from eval code. */
  embeddedIn?: string;
};

type BashAnalyzer = typeof analyzeBash;

function analyzeEmbedded(analyze: BashAnalyzer, command: string): BashAnalysis {
  try {
    return analyze(command);
  } catch (error) {
    return {
      source: command,
      commands: [],
      redirects: [],
      writeRedirectTargets: [],
      groupWriteRedirectTargets: [],
      structure: [],
      allowStructureSafe: false,
      errors: [{
        message: `Bash analysis failed: ${error instanceof Error ? error.message : String(error)}`,
      }],
    };
  }
}

/**
 * Scan an `eval` call and analyze every extracted shell command. A command the
 * shell parser rejects is not matched against rules; it makes the eval opaque so
 * the classifier reviews it.
 */
export function prepareEvalChecks(
  input: Record<string, unknown>,
  analyze: BashAnalyzer,
): EvalChecks {
  const scan = analyzeEval(input);
  const embedded: EmbeddedBashCommand[] = [];
  const opaqueReasons = [...scan.opaqueReasons];
  for (const { command, origin } of scan.commands) {
    const analysis = analyzeEmbedded(analyze, command);
    if (analysis.errors.length > 0) {
      opaqueReasons.push(`${origin}: embedded command could not be parsed as shell`);
      continue;
    }
    embedded.push({ command, origin, analysis });
  }
  return {
    embedded,
    opaqueReasons,
    notes: describeEvalAnalysis({ ...scan, opaqueReasons }),
  };
}

/** The call itself first, then each embedded command as a `bash` call. */
export function permissionTargets(
  toolName: string,
  input: Record<string, unknown>,
  bashAnalysis: BashAnalysis | undefined,
  evalChecks: EvalChecks | undefined,
): PermissionTarget[] {
  const targets: PermissionTarget[] = [{ toolName, input, bashAnalysis }];
  for (const { command, analysis } of evalChecks?.embedded ?? []) {
    targets.push({
      toolName: "bash",
      input: { command },
      bashAnalysis: analysis,
      embeddedIn: EVAL_TOOL,
    });
  }
  return targets;
}

/** Reason suffix naming the tool call a matched command was embedded in. */
export function embeddedNote(target: PermissionTarget): string {
  return target.embeddedIn ? ` (command embedded in ${target.embeddedIn})` : "";
}

/** Run the deterministic hard-deny checks on every command embedded in eval code. */
export function evalHardDeny(evalChecks: EvalChecks, cwd: string): string | undefined {
  for (const { command, origin, analysis } of evalChecks.embedded) {
    const reason = deterministicHardDeny("bash", { command }, cwd, analysis);
    if (reason) return `Embedded in eval (${origin}): ${reason}`;
  }
  return undefined;
}

/** Classifier hints for an eval: notes always, and no fast stage when the eval is opaque. */
export function evalClassifierHints(evalChecks: EvalChecks): ClassifyHints {
  return {
    notes: evalChecks.notes,
    ...(evalChecks.opaqueReasons.length > 0 ? { skipFastStage: true } : {}),
  };
}

/**
 * Whether permission allow rules cover an `eval` call. An opaque eval is never
 * allowed by rules, and every literal shell command embedded in the code must
 * also be covered by `bash(...)` allow rules, so a broad `eval` rule cannot
 * wave through a command the user never allowed.
 */
export function matchesAllowedEvalPatterns(
  patterns: ToolPattern[],
  input: Record<string, unknown>,
  cwd: string,
  evalChecks: EvalChecks,
): boolean {
  if (evalChecks.opaqueReasons.length > 0) return false;
  const evalMatches = patterns.some((pattern) =>
    matchesToolPattern(pattern, EVAL_TOOL, input, cwd, "no-match")
  );
  if (!evalMatches) return false;
  return evalChecks.embedded.every(({ command, analysis }) =>
    matchesAllowedToolPatterns(patterns, "bash", { command }, cwd, analysis)
  );
}
