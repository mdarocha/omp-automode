import test from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	classifyInStages,
	classifyProviderError,
	classifyWithRetry,
	failureFromResponse,
	failureFromThrown,
	formatDuration,
	parseRetryAfterHeader,
	parseRetryAfterMs,
	unavailableReason,
	type ClassifierFailure,
} from "../extensions/auto-mode.ts";

const ANTHROPIC_429 =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_1"} retry-after-ms=179208000';

test("provider errors are typed from status and message", () => {
	const cases: Array<[string, ClassifierFailure["kind"]]> = [
		[ANTHROPIC_429, "rate_limit"],
		["Rate limit exceeded for model", "rate_limit"],
		["You exceeded your current quota", "rate_limit"],
		["503 Service Unavailable", "server"],
		['529 {"type":"error","error":{"type":"overloaded_error"}}', "server"],
		["HTTP 502 bad gateway", "server"],
		["fetch failed: ECONNRESET", "server"],
		["Classifier request timed out after 20000 ms.", "timeout"],
		["Gateway Timeout", "timeout"],
		["408 Request Timeout", "timeout"],
		["401 Unauthorized", "auth"],
		['403 {"error":{"message":"Forbidden"}}', "auth"],
		["402 payment required: billing limit reached", "auth"],
		["Invalid API key provided", "auth"],
		["400 Bad Request", "format"],
		["Unsupported parameter: temperature", "format"],
		["prompt is too long: 250000 tokens > 200000 maximum context length", "format"],
		["something nobody has seen before", "server"],
	];
	for (const [message, kind] of cases) {
		assert.equal(classifyProviderError(message).kind, kind, message);
	}
});

test("an explicit HTTP status wins over the message text", () => {
	assert.equal(classifyProviderError("upstream timed out", 504).kind, "server");
	assert.equal(classifyProviderError("upstream timed out", 429).kind, "rate_limit");
	assert.equal(classifyProviderError("denied", 403).kind, "auth");
});

test("retry-after hints are parsed from OMP messages and response headers", () => {
	assert.equal(parseRetryAfterMs(ANTHROPIC_429), 179_208_000);
	assert.equal(parseRetryAfterMs("429 slow down retry-after: 30"), 30_000);
	assert.equal(parseRetryAfterMs("429 slow down"), undefined);
	assert.equal(classifyProviderError(ANTHROPIC_429).retryAfterMs, 179_208_000);
	assert.equal(classifyProviderError("503 unavailable retry-after-ms=1500").retryAfterMs, 1500);
	assert.equal(classifyProviderError("401 Unauthorized retry-after-ms=1500").retryAfterMs, undefined);
	assert.equal(parseRetryAfterHeader("120"), 120_000);
	assert.equal(parseRetryAfterHeader(null), undefined);
	assert.equal(parseRetryAfterHeader("Wed, 21 Oct 2026 07:28:00 GMT"), undefined);
});

test("thrown errors are typed, and caller cancellation wins", () => {
	assert.equal(failureFromThrown(new Error("Classifier request timed out after 10 ms."), undefined).kind, "timeout");
	assert.equal(failureFromThrown(Object.assign(new Error("nope"), { status: 429 }), undefined).kind, "rate_limit");
	assert.equal(failureFromThrown("socket hang up", undefined).kind, "server");
	const controller = new AbortController();
	controller.abort(new Error("parent cancelled"));
	assert.equal(failureFromThrown(new Error("parent cancelled"), controller.signal).kind, "aborted");
});

function response(stopReason: string, errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "" }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
		...(errorMessage === undefined ? {} : { errorMessage }),
	} as AssistantMessage;
}

test("non-stop responses are typed by stop reason and error message", () => {
	assert.equal(failureFromResponse(response("error", ANTHROPIC_429), "m", undefined).kind, "rate_limit");
	assert.equal(failureFromResponse(response("error", ""), "returned an error", undefined).kind, "server");
	assert.equal(failureFromResponse(response("length"), "truncated", undefined).kind, "format");
	assert.equal(failureFromResponse(response("aborted"), "aborted", undefined).kind, "server");
	const controller = new AbortController();
	controller.abort();
	assert.equal(failureFromResponse(response("aborted"), "aborted", controller.signal).kind, "aborted");
});

test("durations format coarsely", () => {
	assert.equal(formatDuration(1000), "1s");
	assert.equal(formatDuration(45_000), "45s");
	assert.equal(formatDuration(53 * 60_000), "53m");
	assert.equal(formatDuration(179_208_000), "49h 47m");
	assert.equal(formatDuration(2 * 3_600_000), "2h");
});

test("unavailable reasons name the cause and the earliest retry", () => {
	const rateLimited: ClassifierFailure = { kind: "rate_limit", message: "429" };
	assert.equal(
		unavailableReason([rateLimited, rateLimited], 53 * 60_000),
		"classifier unavailable (rate limited, retry in 53m)",
	);
	assert.equal(
		unavailableReason([rateLimited, { kind: "timeout", message: "t" }, { kind: "server", message: "s" }], undefined),
		"classifier unavailable (rate limited, timed out, provider error)",
	);
	assert.equal(
		unavailableReason([{ kind: "auth", message: "No API key found for anthropic" }], undefined),
		"classifier unavailable (authentication failed: No API key found for anthropic)",
	);
	assert.equal(
		unavailableReason([{ kind: "format", message: "Exact tool input cannot fit" }], undefined),
		"classifier unavailable (invalid response: Exact tool input cannot fit)",
	);
	assert.equal(unavailableReason([{ kind: "aborted", message: "x" }], undefined), "classifier unavailable (cancelled)");
	assert.equal(unavailableReason([], undefined), "classifier unavailable (no candidate model)");
});

const CLASSIFIER = { model: { provider: "test", id: "m", contextWindow: 128_000, maxTokens: 4096 } as never };
const STAGED_PROMPT = {
	systemPrompt: "policy",
	contextMessage: { role: "user" as const, content: [{ type: "text" as const, text: "context" }], timestamp: 1 },
	actionMessage: { role: "user" as const, content: [{ type: "text" as const, text: "action" }], timestamp: 1 },
};

test("classifyInStages attaches a typed failure to provider errors, timeouts, and invalid fast output", async () => {
	const limited = await classifyInStages(
		async () => response("error", ANTHROPIC_429),
		CLASSIFIER,
		STAGED_PROMPT,
		undefined,
		{ sessionId: "s" },
	);
	assert.equal(limited.decision, "block");
	assert.equal(limited.failure?.kind, "rate_limit");
	assert.equal(limited.failure?.retryAfterMs, 179_208_000);

	const timedOut = await classifyInStages(
		async () => new Promise<AssistantMessage>(() => {}),
		CLASSIFIER,
		STAGED_PROMPT,
		undefined,
		{ sessionId: "s", timeoutMs: 10 },
	);
	assert.equal(timedOut.failure?.kind, "timeout");

	const garbled = await classifyInStages(
		async () => ({ ...response("stop"), content: [{ type: "text", text: "maybe" }] }) as AssistantMessage,
		CLASSIFIER,
		STAGED_PROMPT,
		undefined,
		{ sessionId: "s" },
	);
	assert.equal(garbled.failure?.kind, "format");

	const allowed = await classifyInStages(
		async () => ({ ...response("stop"), content: [{ type: "text", text: "0" }] }) as AssistantMessage,
		CLASSIFIER,
		STAGED_PROMPT,
		undefined,
		{ sessionId: "s" },
	);
	assert.equal(allowed.decision, "allow");
	assert.equal(allowed.failure, undefined);
});

test("classifyWithRetry types thrown errors, cancellation, and exhausted invalid output", async () => {
	const thrown = await classifyWithRetry(
		async () => {
			throw Object.assign(new Error("Service Unavailable"), { status: 503 });
		},
		CLASSIFIER,
		{ systemPrompt: "s", messages: [] },
		undefined,
	);
	assert.equal(thrown.failure?.kind, "server");

	const controller = new AbortController();
	controller.abort(new Error("stop"));
	const cancelled = await classifyWithRetry(
		async () => {
			throw new Error("stop");
		},
		CLASSIFIER,
		{ systemPrompt: "s", messages: [] },
		controller.signal,
	);
	assert.equal(cancelled.failure?.kind, "aborted");

	const invalid = await classifyWithRetry(
		async () => ({ ...response("toolUse"), content: [{ type: "text", text: "nonsense" }] }) as AssistantMessage,
		CLASSIFIER,
		{ systemPrompt: "s", messages: [] },
		undefined,
	);
	assert.equal(invalid.failure?.kind, "format");
});
