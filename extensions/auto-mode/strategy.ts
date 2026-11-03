import type { ClassifierStrategy } from "./types.ts";

export const CLASSIFIER_STRATEGIES: readonly ClassifierStrategy[] = [
  "staged",
  "detailed",
  "hybrid",
];
/** The one-token gate then the detailed review: the behaviour before strategies existed. */
export const DEFAULT_CLASSIFIER_STRATEGY: ClassifierStrategy = "staged";
/** Probability a judge answer must reach on the safe side before it can approve an action. */
export const DEFAULT_JUDGE_CONFIDENCE = 0.9;
/** The omp model role whose chain answers judge questions. */
export const JUDGE_ROLE = "judge";

export function isClassifierStrategy(value: unknown): value is ClassifierStrategy {
  return typeof value === "string" &&
    (CLASSIFIER_STRATEGIES as readonly string[]).includes(value);
}

/** A probability in (0.5, 1]: at or below 0.5 a "safe" answer would not be the likelier one. */
export function isJudgeConfidence(value: unknown): value is number {
  return typeof value === "number" && value > 0.5 && value <= 1;
}

/** The four policy questions a judge answers, as the probability that each is "yes". */
export type JudgeProbabilities = {
  hard_deny: number;
  soft_deny: number;
  allow_exception: number;
  direct_authorization: number;
};

export type JudgeVerdict = {
  allow: boolean;
  /** The `ClassificationDecision` tier an approval maps to. */
  tier: "none" | "allow" | "explicit_intent";
  reason: string;
};

/**
 * Whether judge answers clear an action. The judge can only approve: every
 * other outcome escalates to the detailed classifier, so a doubtful or wrong
 * judge costs latency, never a block or a silent allow of a doubtful action.
 *
 * Approve when P(no HARD_DENY) reaches `confidence` and either P(no SOFT_DENY)
 * reaches it, or ALLOW exceptions or direct user authorization cover the soft
 * denial with at least that probability.
 */
export function judgeVerdict(
  probabilities: JudgeProbabilities,
  confidence: number,
): JudgeVerdict {
  const noHardDeny = 1 - probabilities.hard_deny;
  const noSoftDeny = 1 - probabilities.soft_deny;
  const exception = probabilities.allow_exception;
  const authorized = probabilities.direct_authorization;
  const summary = `P(no hard_deny)=${noHardDeny.toFixed(2)}, P(no soft_deny)=${
    noSoftDeny.toFixed(2)
  }, P(exception)=${exception.toFixed(2)}, P(authorized)=${authorized.toFixed(2)}`;
  if (noHardDeny < confidence) {
    return { allow: false, tier: "none", reason: `hard_deny not ruled out (${summary})` };
  }
  if (noSoftDeny >= confidence) {
    return { allow: true, tier: "none", reason: summary };
  }
  if (Math.max(exception, authorized) >= confidence) {
    return {
      allow: true,
      tier: exception >= authorized ? "allow" : "explicit_intent",
      reason: summary,
    };
  }
  return { allow: false, tier: "none", reason: `soft_deny not ruled out (${summary})` };
}
