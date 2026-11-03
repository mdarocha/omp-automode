import test from "node:test";
import assert from "node:assert/strict";
import {
	ClassifierCooldowns,
	DEFAULT_RATE_LIMIT_COOLDOWN_MS,
	MAX_CLASSIFIER_CANDIDATES,
	MAX_COOLDOWN_MS,
	TIMEOUT_COOLDOWN_MS,
	TRANSIENT_RETRY_DELAY_MS,
	classifyWithFallback,
	type ClassifierFailure,
	type ClassifierIoAttempt,
	type ClassifyResult,
} from "../extensions/auto-mode.ts";

type Candidate = { provider: string; id: string };

const A1: Candidate = { provider: "anthropic", id: "haiku" };
const A2: Candidate = { provider: "anthropic", id: "sonnet" };
const B1: Candidate = { provider: "github-copilot", id: "haiku" };
const C1: Candidate = { provider: "openrouter", id: "flash" };

const ALLOW: ClassifyResult = { decision: "allow", tier: "none", reason: "ok" };
const POLICY_BLOCK: ClassifyResult = { decision: "block", tier: "soft_deny", reason: "no" };

function failing(failure: ClassifierFailure): ClassifyResult {
	return { decision: "block", tier: "none", reason: failure.message, failure };
}

const RATE_LIMITED = (retryAfterMs?: number): ClassifyResult =>
	failing({ kind: "rate-limit", message: "429", ...(retryAfterMs === undefined ? {} : { retryAfterMs }) });
const TIMED_OUT = failing({ kind: "timeout", message: "timed out" });
const SERVER_ERROR = failing({ kind: "server", message: "503" });
const BAD_FORMAT = failing({ kind: "invalid-response", message: "garbage" });

/** A manual clock plus a scripted `run`: each candidate pops its next result. */
function harness(script: Record<string, ClassifyResult[]>, runMs = 0) {
	let clock = 1_000_000;
	const calls: string[] = [];
	const sleeps: number[] = [];
	const cooldowns = new ClassifierCooldowns(() => clock);
	return {
		calls,
		sleeps,
		cooldowns,
		advance(ms: number) {
			clock += ms;
		},
		options: {
			cooldowns,
			budgetMs: 60_000,
			now: () => clock,
			random: () => 0.5,
			sleep: async (ms: number) => {
				sleeps.push(ms);
				clock += ms;
			},
		},
		async run(candidate: Candidate): Promise<ClassifyResult> {
			const key = `${candidate.provider}/${candidate.id}`;
			calls.push(key);
			clock += runMs;
			const next = script[key]?.shift();
			if (!next) {
				throw new Error(`unscripted call for ${key}`);
			}
			return next;
		},
	};
}

test("a decision from the first candidate ends the walk", async () => {
	const h = harness({ "anthropic/haiku": [ALLOW] });
	const result = await classifyWithFallback([A1, B1], (c) => h.run(c), h.options);
	assert.equal(result.decision, "allow");
	assert.equal(result.failure, undefined);
	assert.deepEqual(h.calls, ["anthropic/haiku"]);
});

test("a policy block is a decision, not a failure, and does not fall through", async () => {
	const h = harness({ "anthropic/haiku": [POLICY_BLOCK], "github-copilot/haiku": [ALLOW] });
	const result = await classifyWithFallback([A1, B1], (c) => h.run(c), h.options);
	assert.equal(result.decision, "block");
	assert.equal(result.failure, undefined);
	assert.deepEqual(h.calls, ["anthropic/haiku"]);
});

test("a 429 moves to the next candidate and puts the provider on cooldown", async () => {
	const h = harness({ "anthropic/haiku": [RATE_LIMITED(5 * 60_000)], "github-copilot/haiku": [ALLOW, ALLOW] });
	const first = await classifyWithFallback([A1, B1], (c) => h.run(c), h.options);
	assert.equal(first.decision, "allow");
	assert.deepEqual(h.calls, ["anthropic/haiku", "github-copilot/haiku"]);

	// The next decision skips the throttled provider without a request.
	const second = await classifyWithFallback([A1, B1], (c) => h.run(c), h.options);
	assert.equal(second.decision, "allow");
	assert.deepEqual(h.calls, ["anthropic/haiku", "github-copilot/haiku", "github-copilot/haiku"]);
});

test("the cooldown ends after the provider's retry-after, then the provider is probed again", async () => {
	const h = harness({ "anthropic/haiku": [RATE_LIMITED(5 * 60_000), ALLOW], "github-copilot/haiku": [ALLOW] });
	await classifyWithFallback([A1, B1], (c) => h.run(c), h.options);
	h.advance(5 * 60_000 - 1);
	assert.ok(h.cooldowns.active(A1));
	h.advance(1);
	assert.equal(h.cooldowns.active(A1), undefined);
	const result = await classifyWithFallback([A1, B1], (c) => h.run(c), h.options);
	assert.equal(result.decision, "allow");
	assert.deepEqual(h.calls, ["anthropic/haiku", "github-copilot/haiku", "anthropic/haiku"]);
});

test("a rate limit without a hint uses the default cooldown; a huge hint is capped", () => {
	let clock = 0;
	const cooldowns = new ClassifierCooldowns(() => clock);
	cooldowns.trip(A1, { kind: "rate-limit", message: "429" });
	clock = DEFAULT_RATE_LIMIT_COOLDOWN_MS - 1;
	assert.ok(cooldowns.active(A1));
	clock = DEFAULT_RATE_LIMIT_COOLDOWN_MS;
	assert.equal(cooldowns.active(A1), undefined);

	clock = 0;
	cooldowns.trip(B1, { kind: "rate-limit", message: "429", retryAfterMs: 50 * 3_600_000 });
	clock = MAX_COOLDOWN_MS - 1;
	assert.ok(cooldowns.active(B1));
	assert.equal(cooldowns.active(B1)?.retryInMs, 50 * 3_600_000 - clock);
	clock = MAX_COOLDOWN_MS;
	assert.equal(cooldowns.active(B1), undefined);
});

test("only rate limits and repeated timeouts trip the circuit breaker", () => {
	const cooldowns = new ClassifierCooldowns(() => 0);
	for (const kind of ["timeout", "server", "auth", "invalid-response", "aborted"] as const) {
		cooldowns.trip(A1, { kind, message: kind });
		assert.equal(cooldowns.active(A1), undefined, kind);
	}
	cooldowns.clear();
	cooldowns.trip(A1, { kind: "rate-limit", message: "429" });
	assert.ok(cooldowns.active(A1));
	cooldowns.clear();
	assert.equal(cooldowns.active(A1), undefined);
});

test("two consecutive timeouts bench that model for a minute; a success resets the streak", () => {
	let clock = 0;
	const cooldowns = new ClassifierCooldowns(() => clock);
	const timeout: ClassifierFailure = { kind: "timeout", message: "timed out" };
	cooldowns.trip(A1, timeout);
	cooldowns.recordSuccess(A1);
	cooldowns.trip(A1, timeout);
	assert.equal(cooldowns.active(A1), undefined, "a success between timeouts resets the streak");
	cooldowns.trip(A1, timeout);
	assert.equal(cooldowns.active(A1)?.failure.kind, "timeout");
	assert.equal(cooldowns.active(A1)?.retryInMs, TIMEOUT_COOLDOWN_MS);
	assert.equal(cooldowns.active(A2), undefined, "other models of the provider keep working");
	clock = TIMEOUT_COOLDOWN_MS;
	assert.equal(cooldowns.active(A1), undefined);
	cooldowns.trip(A1, timeout);
	assert.equal(cooldowns.active(A1), undefined, "the streak starts over after the cooldown");
});

test("a model that timed out twice is skipped on later calls without a request", async () => {
	const h = harness({ "anthropic/haiku": [TIMED_OUT, TIMED_OUT], "github-copilot/haiku": [ALLOW, ALLOW] });
	await classifyWithFallback([A1, B1], (c) => h.run(c), h.options);
	assert.deepEqual(h.calls, ["anthropic/haiku", "anthropic/haiku", "github-copilot/haiku"]);
	await classifyWithFallback([A1, B1], (c) => h.run(c), h.options);
	assert.deepEqual(h.calls.slice(3), ["github-copilot/haiku"]);
	h.advance(TIMEOUT_COOLDOWN_MS);
	assert.equal(h.cooldowns.active(A1), undefined);
});

test("the retry is skipped when the first timeout already opens the circuit", async () => {
	const h = harness({ "anthropic/haiku": [TIMED_OUT], "github-copilot/haiku": [ALLOW] });
	h.cooldowns.trip(A1, { kind: "timeout", message: "earlier" });
	await classifyWithFallback([A1, B1], (c) => h.run(c), h.options);
	assert.deepEqual(h.calls, ["anthropic/haiku", "github-copilot/haiku"]);
	assert.deepEqual(h.sleeps, []);
});

test("a cooldown covers every model of the provider", async () => {
	const h = harness({ "anthropic/haiku": [RATE_LIMITED(60_000)], "openrouter/flash": [ALLOW] });
	const result = await classifyWithFallback([A1, A2, C1], (c) => h.run(c), h.options);
	assert.equal(result.decision, "allow");
	// anthropic/sonnet shares the account, so it is neither tried nor preferred.
	assert.deepEqual(h.calls, ["anthropic/haiku", "openrouter/flash"]);
});

test("after a provider failure the walk prefers a different provider over the same one", async () => {
	for (const failure of [TIMED_OUT, SERVER_ERROR]) {
		const h = harness({ "anthropic/haiku": [failure, failure], "github-copilot/haiku": [ALLOW] });
		const result = await classifyWithFallback([A1, A2, B1], (c) => h.run(c), h.options);
		assert.equal(result.decision, "allow");
		assert.deepEqual(h.calls, ["anthropic/haiku", "anthropic/haiku", "github-copilot/haiku"]);
	}
});

test("an invalid response from one model falls back to the next, even on the same provider", async () => {
	const h = harness({ "anthropic/haiku": [BAD_FORMAT], "anthropic/sonnet": [ALLOW] });
	const result = await classifyWithFallback([A1, A2, B1], (c) => h.run(c), h.options);
	assert.equal(result.decision, "allow");
	assert.deepEqual(h.calls, ["anthropic/haiku", "anthropic/sonnet"]);
	assert.deepEqual(h.sleeps, []);
});

test("a timeout or server error is retried once after a jittered pause", async () => {
	for (const failure of [TIMED_OUT, SERVER_ERROR]) {
		const h = harness({ "anthropic/haiku": [failure, ALLOW] });
		const result = await classifyWithFallback([A1, B1], (c) => h.run(c), h.options);
		assert.equal(result.decision, "allow");
		assert.deepEqual(h.calls, ["anthropic/haiku", "anthropic/haiku"]);
		const { min, max } = TRANSIENT_RETRY_DELAY_MS;
		assert.deepEqual(h.sleeps, [min + 0.5 * (max - min)]);
	}
});

test("the jitter spans the configured range", async () => {
	for (const [random, expected] of [[0, TRANSIENT_RETRY_DELAY_MS.min], [0.999, TRANSIENT_RETRY_DELAY_MS.max]] as const) {
		const h = harness({ "anthropic/haiku": [TIMED_OUT, ALLOW] });
		await classifyWithFallback([A1], (c) => h.run(c), { ...h.options, random: () => random });
		assert.ok(Math.abs((h.sleeps[0] ?? 0) - expected) < 1, `${random}`);
	}
});

test("the retry happens once per candidate", async () => {
	const h = harness({ "anthropic/haiku": [TIMED_OUT, TIMED_OUT, TIMED_OUT], "github-copilot/haiku": [SERVER_ERROR, SERVER_ERROR] });
	const result = await classifyWithFallback([A1, B1], (c) => h.run(c), h.options);
	assert.equal(result.failure?.kind, "server");
	assert.deepEqual(h.calls, ["anthropic/haiku", "anthropic/haiku", "github-copilot/haiku", "github-copilot/haiku"]);
});

test("rate limits, credential failures, and invalid output are not retried on the same candidate", async () => {
	for (const failure of [RATE_LIMITED(), failing({ kind: "auth", message: "401" }), BAD_FORMAT]) {
		const h = harness({ "anthropic/haiku": [failure], "github-copilot/haiku": [ALLOW] });
		await classifyWithFallback([A1, B1], (c) => h.run(c), h.options);
		assert.deepEqual(h.calls, ["anthropic/haiku", "github-copilot/haiku"]);
		assert.deepEqual(h.sleeps, []);
	}
});

test("cancellation ends the walk and is reported as cancelled", async () => {
	const h = harness({ "anthropic/haiku": [failing({ kind: "aborted", message: "aborted" })], "github-copilot/haiku": [ALLOW] });
	const result = await classifyWithFallback([A1, B1], (c) => h.run(c), h.options);
	assert.equal(result.decision, "block");
	assert.equal(result.reason, "classifier unavailable (cancelled)");
	assert.equal(result.failure?.kind, "aborted");
	assert.deepEqual(h.calls, ["anthropic/haiku"]);

	const controller = new AbortController();
	controller.abort();
	const skipped = harness({});
	const early = await classifyWithFallback([A1], (c) => skipped.run(c), { ...skipped.options, signal: controller.signal });
	assert.equal(early.failure?.kind, "aborted");
	assert.deepEqual(skipped.calls, []);
});

test("when every candidate fails the block says the classifier is unavailable, with the earliest retry", async () => {
	const h = harness({ "anthropic/haiku": [RATE_LIMITED(53 * 60_000)], "github-copilot/haiku": [RATE_LIMITED(90 * 60_000)] });
	const result = await classifyWithFallback([A1, B1], (c) => h.run(c), h.options);
	assert.equal(result.decision, "block");
	assert.equal(result.tier, "none");
	assert.equal(result.reason, "classifier unavailable (rate limited, retry in 53m)");
	assert.equal(result.failure?.kind, "rate-limit");
	assert.equal(result.failure?.retryAfterMs, 53 * 60_000);
});

test("repeated decisions during an outage fail fast without a request and keep counting down", async () => {
	const h = harness({ "anthropic/haiku": [RATE_LIMITED(53 * 60_000)] });
	const first = await classifyWithFallback([A1], (c) => h.run(c), h.options);
	assert.equal(first.reason, "classifier unavailable (rate limited, retry in 53m)");
	h.advance(3 * 60_000);
	const second = await classifyWithFallback([A1, A2], (c) => h.run(c), h.options);
	assert.equal(second.reason, "classifier unavailable (rate limited, retry in 50m)");
	assert.deepEqual(h.calls, ["anthropic/haiku"]);
});

test("no retry time is shown when a failure has no known recovery time", async () => {
	const h = harness({ "anthropic/haiku": [RATE_LIMITED(53 * 60_000)], "github-copilot/haiku": [TIMED_OUT, TIMED_OUT] });
	const result = await classifyWithFallback([A1, B1], (c) => h.run(c), h.options);
	assert.equal(result.reason, "classifier unavailable (rate limited, timed out)");
});

test("an exception from a candidate becomes a typed failure and the walk continues", async () => {
	const result = await classifyWithFallback(
		[A1, B1],
		async (candidate) => {
			if (candidate === A1) {
				throw new Error("503 Service Unavailable");
			}
			return ALLOW;
		},
		{ ...harness({}).options },
	);
	assert.equal(result.decision, "allow");
});

test("at most MAX_CLASSIFIER_CANDIDATES distinct candidates are tried", async () => {
	const chain = Array.from({ length: 7 }, (_, index): Candidate => ({ provider: `p${index}`, id: "m" }));
	const script = Object.fromEntries(chain.map((c) => [`${c.provider}/${c.id}`, [BAD_FORMAT]]));
	const h = harness(script);
	const result = await classifyWithFallback(chain, (c) => h.run(c), h.options);
	assert.equal(h.calls.length, MAX_CLASSIFIER_CANDIDATES);
	assert.equal(result.failure?.kind, "invalid-response");
});

test("no new attempt starts after the decision budget is used", async () => {
	const h = harness(
		{ "anthropic/haiku": [TIMED_OUT, TIMED_OUT], "github-copilot/haiku": [TIMED_OUT, TIMED_OUT], "openrouter/flash": [ALLOW] },
		10_000,
	);
	const result = await classifyWithFallback([A1, B1, C1], (c) => h.run(c), { ...h.options, budgetMs: 25_000 });
	// A1 (10s), its retry (20s), B1 (30s): the budget is spent, so there is no retry and no C1.
	assert.deepEqual(h.calls, ["anthropic/haiku", "anthropic/haiku", "github-copilot/haiku"]);
	assert.equal(result.decision, "block");
	assert.equal(result.failure?.kind, "timeout");
});

test("attempts from every candidate are merged, stamped with the model, and typed when failed", async () => {
	const attempt = (error?: string): ClassifierIoAttempt => ({ stage: "fast", attempt: 1, durationMs: 5, ...(error === undefined ? {} : { error }) });
	const io = (attempts: ClassifierIoAttempt[], model: string): NonNullable<ClassifyResult["io"]> => ({
		model,
		reasoning: { mode: "server-default" },
		prompt: { system: "", context: "", action: "", fastInstruction: "", detailedInstruction: "" },
		attempts,
		durationMs: 5,
	});
	const results: Record<string, ClassifyResult> = {
		"anthropic/haiku": { ...RATE_LIMITED(1000), io: io([attempt("429")], "anthropic/haiku") },
		"github-copilot/haiku": { ...ALLOW, io: io([attempt()], "github-copilot/haiku") },
	};
	const h = harness({});
	const result = await classifyWithFallback([A1, B1], async (c) => results[`${c.provider}/${c.id}`]!, h.options);
	assert.equal(result.decision, "allow");
	assert.equal(result.io?.model, "github-copilot/haiku");
	assert.deepEqual(
		result.io?.attempts.map(({ model, errorKind, retryAfterMs, error }) => ({ model, errorKind, retryAfterMs, error })),
		[
			{ model: "anthropic/haiku", errorKind: "rate-limit", retryAfterMs: 1000, error: "429" },
			{ model: "github-copilot/haiku", errorKind: undefined, retryAfterMs: undefined, error: undefined },
		],
	);
});
