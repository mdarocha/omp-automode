import { failureFromThrown, unavailableReason } from "./classifier-errors.ts";
import type {
  ClassifierErrorKind,
  ClassifierFailure,
  ClassifierIoAttempt,
  ClassifyResult,
} from "./types.ts";

/** Cooldown for a rate-limited provider that gave no retry hint. */
export const DEFAULT_RATE_LIMIT_COOLDOWN_MS = 60_000;
/**
 * Longest a provider stays skipped, whatever it asked for. A provider that
 * asks for hours still gets probed by one request every few minutes.
 */
export const MAX_COOLDOWN_MS = 10 * 60_000;
/** Pause before the one retry of a timeout or server error, jittered to avoid lockstep retries. */
export const TRANSIENT_RETRY_DELAY_MS = { min: 250, max: 750 } as const;
/** Distinct candidates tried per decision, so a long role chain cannot stall a tool call. */
export const MAX_CLASSIFIER_CANDIDATES = 4;
/** No further attempt starts once a decision has used this many request timeouts. */
export const DECISION_BUDGET_TIMEOUTS = 3;
/** Consecutive timeouts of one model (an attempt and its retry count as two) that bench it. */
export const TIMEOUT_STREAK_THRESHOLD = 2;
/** How long a model that timed out repeatedly is skipped. */
export const TIMEOUT_COOLDOWN_MS = 60_000;

/** Failures worth one more try on the same candidate. */
const TRANSIENT_KINDS: Partial<Record<ClassifierErrorKind, true>> = {
  timeout: true,
  server: true,
};
/** Failures that say something about the provider, not the one model. */
const PROVIDER_KINDS: Partial<Record<ClassifierErrorKind, true>> = {
  "rate-limit": true,
  auth: true,
  timeout: true,
  server: true,
};

export type FallbackCandidate = { provider: string; id: string };

function modelKey(candidate: FallbackCandidate): string {
  return `${candidate.provider}/${candidate.id}`;
}

type Cooldown = { until: number; retryAt?: number; failure: ClassifierFailure };

/**
 * Circuit breaker. A rate limit applies to the whole account, so one throttled
 * model keeps every model of that provider out of the walk until the cooldown
 * ends. Consecutive timeouts bench the one slow model for a short while, so it
 * does not cost a full timeout, and its retry, on every call. A success resets
 * the streak. Server errors and credential problems never trip it: the first
 * clears on a retry or another candidate, and the second is fixed by the user,
 * who should not have to wait.
 */
export class ClassifierCooldowns {
  readonly #entries = new Map<string, Cooldown>();
  readonly #timeouts = new Map<string, number>();
  readonly #now: () => number;

  constructor(now: () => number = Date.now) {
    this.#now = now;
  }

  trip(candidate: FallbackCandidate, failure: ClassifierFailure): void {
    const now = this.#now();
    if (failure.kind === "rate-limit") {
      const hint = failure.retryAfterMs;
      this.#entries.set(candidate.provider, {
        until: now + Math.min(hint ?? DEFAULT_RATE_LIMIT_COOLDOWN_MS, MAX_COOLDOWN_MS),
        ...(hint === undefined ? {} : { retryAt: now + hint }),
        failure,
      });
    } else if (failure.kind === "timeout") {
      const model = modelKey(candidate);
      const streak = (this.#timeouts.get(model) ?? 0) + 1;
      if (streak < TIMEOUT_STREAK_THRESHOLD) {
        this.#timeouts.set(model, streak);
        return;
      }
      this.#timeouts.delete(model);
      this.#entries.set(model, {
        until: now + TIMEOUT_COOLDOWN_MS,
        retryAt: now + TIMEOUT_COOLDOWN_MS,
        failure,
      });
    }
  }

  /** A decision from this candidate ends its timeout streak. */
  recordSuccess(candidate: FallbackCandidate): void {
    this.#timeouts.delete(modelKey(candidate));
  }

  /** The failure that benched this candidate (or its provider), with the estimate of when it recovers. */
  active(
    candidate: FallbackCandidate,
  ): { failure: ClassifierFailure; retryInMs?: number } | undefined {
    const now = this.#now();
    for (const key of [candidate.provider, modelKey(candidate)]) {
      const entry = this.#entries.get(key);
      if (!entry) {
        continue;
      }
      if (now >= entry.until) {
        this.#entries.delete(key);
        continue;
      }
      return {
        failure: entry.failure,
        ...(entry.retryAt === undefined
          ? {}
          : { retryInMs: Math.max(0, entry.retryAt - now) }),
      };
    }
    return undefined;
  }

  clear(): void {
    this.#entries.clear();
    this.#timeouts.clear();
  }
}

/** Cooldowns shared by every session in the process: subagents hit the same accounts. */
export const classifierCooldowns = new ClassifierCooldowns();

export type FallbackOptions = {
  cooldowns?: ClassifierCooldowns;
  /** Soft wall-clock limit: no new attempt starts once it has elapsed. */
  budgetMs: number;
  signal?: AbortSignal;
  maxCandidates?: number;
  now?: () => number;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  random?: () => number;
};

function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal?.removeEventListener("abort", done);
      resolve();
    }
    signal?.addEventListener("abort", done, { once: true });
  });
}

/** Stamp one run's attempts with the model that served them and, for the last, the typed failure. */
function stampAttempts(
  attempts: ClassifierIoAttempt[],
  model: string,
  failure: ClassifierFailure | undefined,
): ClassifierIoAttempt[] {
  return attempts.map((attempt, index) => ({
    ...attempt,
    model,
    ...(failure !== undefined && index === attempts.length - 1
      ? {
        errorKind: failure.kind,
        ...(failure.retryAfterMs === undefined
          ? {}
          : { retryAfterMs: failure.retryAfterMs }),
      }
      : {}),
  }));
}

/**
 * Walk `candidates` until one returns a decision. `run` reports a candidate it
 * could not use through `failure` on its result; any other result, including a
 * block, is a decision and ends the walk.
 *
 * - A timeout or server error is retried once on the same candidate after a
 *   short jittered pause.
 * - Any other failure, or a failed retry, moves on to the next candidate, preferring
 *   a provider that has not failed yet.
 * - Rate limits and credential failures put the provider on cooldown, so later
 *   decisions skip it without a request.
 * - When no candidate can decide, the result is a block whose `failure` is set
 *   and whose reason reads `classifier unavailable (...)`.
 */
export async function classifyWithFallback<C extends FallbackCandidate>(
  candidates: readonly C[],
  run: (candidate: C) => Promise<ClassifyResult>,
  options: FallbackOptions,
): Promise<ClassifyResult> {
  const cooldowns = options.cooldowns ?? classifierCooldowns;
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? defaultSleep;
  const random = options.random ?? Math.random;
  const maxCandidates = options.maxCandidates ?? MAX_CLASSIFIER_CANDIDATES;
  const started = now();
  const withinBudget = () => now() - started < options.budgetMs;

  const remaining = [...candidates];
  const failedProviders = new Set<string>();
  const failures: ClassifierFailure[] = [];
  /** Per failure: when the provider said it would accept requests again, if it did. */
  const retryInMs: Array<number | undefined> = [];
  const attempts: ClassifierIoAttempt[] = [];
  let lastIo: ClassifyResult["io"];
  let lastReasoning: ClassifyResult["reasoning"];
  let tried = 0;

  const unavailable = (cancelled = false): ClassifyResult => {
    const known = retryInMs.filter((ms): ms is number => ms !== undefined);
    const retryIn = known.length === retryInMs.length && known.length > 0
      ? Math.min(...known)
      : undefined;
    const reason = unavailableReason(failures, retryIn);
    const last = failures.at(-1);
    const kind = cancelled ? "aborted" : last?.kind ?? "server";
    return {
      decision: "block",
      tier: "none",
      reason,
      failure: {
        kind,
        message: reason,
        ...(last?.stage === undefined ? {} : { stage: last.stage }),
        ...(retryIn === undefined ? {} : { retryAfterMs: retryIn }),
      },
      ...(lastReasoning === undefined ? {} : { reasoning: lastReasoning }),
      ...(lastIo === undefined
        ? {}
        : { io: { ...lastIo, attempts, durationMs: now() - started } }),
    };
  };

  while (remaining.length > 0 && tried < maxCandidates && withinBudget()) {
    if (options.signal?.aborted) {
      failures.push({ kind: "aborted", message: "classifier request cancelled" });
      retryInMs.push(undefined);
      return unavailable(true);
    }
    // Candidates on a cooling provider are skipped without a request.
    const cooling = remaining.findIndex((candidate) => cooldowns.active(candidate));
    if (cooling >= 0) {
      const [candidate] = remaining.splice(cooling, 1);
      const active = cooldowns.active(candidate!)!;
      failures.push(active.failure);
      retryInMs.push(active.retryInMs);
      continue;
    }
    const preferred = remaining.findIndex(
      (candidate) => !failedProviders.has(candidate.provider),
    );
    const [candidate] = remaining.splice(preferred < 0 ? 0 : preferred, 1);
    const model = `${candidate!.provider}/${candidate!.id}`;
    tried += 1;

    let failure: ClassifierFailure | undefined;
    for (let attempt = 0;; attempt += 1) {
      let result: ClassifyResult;
      try {
        result = await run(candidate!);
      } catch (error) {
        result = {
          decision: "block",
          tier: "none",
          reason: error instanceof Error ? error.message : String(error),
          failure: failureFromThrown(error, options.signal),
        };
      }
      failure = result.failure;
      lastReasoning = result.reasoning ?? lastReasoning;
      if (result.io) {
        lastIo = result.io;
        attempts.push(...stampAttempts(result.io.attempts, model, failure));
      }
      if (!failure) {
        cooldowns.recordSuccess(candidate!);
        return {
          ...result,
          ...(result.io === undefined
            ? {}
            : { io: { ...result.io, attempts, durationMs: now() - started } }),
        };
      }
      if (failure.kind === "aborted") {
        failures.push(failure);
        retryInMs.push(undefined);
        return unavailable(true);
      }
      cooldowns.trip(candidate!, failure);
      if (
        attempt === 0 && TRANSIENT_KINDS[failure.kind] && withinBudget() &&
        !options.signal?.aborted && !cooldowns.active(candidate!)
      ) {
        const { min, max } = TRANSIENT_RETRY_DELAY_MS;
        await sleep(min + random() * (max - min), options.signal);
        continue;
      }
      break;
    }

    failures.push(failure);
    retryInMs.push(failure.kind === "rate-limit" ? failure.retryAfterMs : undefined);
    if (PROVIDER_KINDS[failure.kind]) {
      failedProviders.add(candidate!.provider);
    }
  }
  return unavailable();
}
