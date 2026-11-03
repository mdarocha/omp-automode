import test from "node:test";
import assert from "node:assert/strict";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	classifierCooldowns,
	defaultClassifyAction,
	setOmpBridgeForTesting,
	type OmpBridge,
} from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, setupHookTest } from "./test-helpers.ts";

const CLASSIFIER_ACTION = '{"toolName":"bash","input":{"command":"echo ok"}}';

function model(provider: string, id: string): Model<Api> {
	// Only the fields the classifier reads exist on this fake model.
	return {
		provider,
		id,
		api: "test-api",
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 4096,
	} as unknown as Model<Api>;
}

const ANTHROPIC = model("anthropic", "haiku");
const COPILOT = model("github-copilot", "haiku");

function reply(text: string, stopReason = "stop", errorMessage?: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
		...(errorMessage === undefined ? {} : { errorMessage }),
	} as AssistantMessage;
}

const RATE_LIMIT_53M =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit."}} retry-after-ms=3200000';

type Responder = (callModel: Model<Api>, callIndex: number) => AssistantMessage | Promise<AssistantMessage>;

/** Runs `run` with a role chain [ANTHROPIC, COPILOT] and a registry whose completions come from `responder`. */
async function withChain<T>(
	responder: Responder,
	run: (ctx: ExtensionContext, calls: string[]) => Promise<T>,
): Promise<T> {
	const bridge: OmpBridge = { roleChain: () => [ANTHROPIC, COPILOT] };
	const calls: string[] = [];
	// The fake context implements only what the classifier reads.
	const ctx = createFakeCtx([], {
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
			async complete(callModel: Model<Api>) {
				calls.push(`${callModel.provider}/${callModel.id}`);
				return responder(callModel, calls.length - 1);
			},
		},
	}) as unknown as ExtensionContext;
	classifierCooldowns.clear();
	setOmpBridgeForTesting(bridge);
	try {
		return await run(ctx, calls);
	} finally {
		setOmpBridgeForTesting(undefined);
		classifierCooldowns.clear();
	}
}

const CONFIG = baseConfig({ classifierModel: "@smol" });

test("a rate-limited first provider falls back to the next chain candidate, and the log shows both attempts", async () => {
	await withChain(
		(callModel) => callModel.provider === "anthropic" ? reply("", "error", RATE_LIMIT_53M) : reply("0"),
		async (ctx, calls) => {
			const result = await defaultClassifyAction(ctx, CONFIG, CLASSIFIER_ACTION, "");
			assert.equal(result.decision, "allow");
			assert.equal(result.failure, undefined);
			assert.deepEqual(calls, ["anthropic/haiku", "github-copilot/haiku"]);
			assert.equal(result.io?.model, "github-copilot/haiku");
			assert.deepEqual(
				result.io?.attempts.map(({ model: served, errorKind, retryAfterMs }) => ({ served, errorKind, retryAfterMs })),
				[
					{ served: "anthropic/haiku", errorKind: "rate_limit", retryAfterMs: 3_200_000 },
					{ served: "github-copilot/haiku", errorKind: undefined, retryAfterMs: undefined },
				],
			);
		},
	);
});

test("later decisions skip the throttled provider until its cooldown ends", async () => {
	await withChain(
		(callModel) => callModel.provider === "anthropic" ? reply("", "error", RATE_LIMIT_53M) : reply("0"),
		async (ctx, calls) => {
			await defaultClassifyAction(ctx, CONFIG, CLASSIFIER_ACTION, "");
			await defaultClassifyAction(ctx, CONFIG, CLASSIFIER_ACTION, "");
			await defaultClassifyAction(ctx, CONFIG, CLASSIFIER_ACTION, "");
			assert.deepEqual(calls, ["anthropic/haiku", "github-copilot/haiku", "github-copilot/haiku", "github-copilot/haiku"]);
		},
	);
});

test("when every candidate is rate limited the result is a distinct, typed unavailability", async () => {
	await withChain(
		() => reply("", "error", RATE_LIMIT_53M),
		async (ctx, calls) => {
			const result = await defaultClassifyAction(ctx, CONFIG, CLASSIFIER_ACTION, "");
			assert.equal(result.decision, "block");
			assert.equal(result.reason, "classifier unavailable (rate limited, retry in 53m)");
			assert.equal(result.failure?.kind, "rate_limit");
			assert.deepEqual(calls, ["anthropic/haiku", "github-copilot/haiku"]);

			const again = await defaultClassifyAction(ctx, CONFIG, CLASSIFIER_ACTION, "");
			assert.match(again.reason, /^classifier unavailable \(rate limited, retry in 5\dm\)$/);
			assert.equal(calls.length, 2, "the open circuit makes no further request");
		},
	);
});

test("a transient server error is retried once on the same candidate", async () => {
	await withChain(
		(_model, callIndex) => callIndex === 0 ? reply("", "error", "503 Service Unavailable") : reply("0"),
		async (ctx, calls) => {
			const result = await defaultClassifyAction(ctx, CONFIG, CLASSIFIER_ACTION, "");
			assert.equal(result.decision, "allow");
			assert.deepEqual(calls, ["anthropic/haiku", "anthropic/haiku"]);
		},
	);
});

test("a thrown request timeout is typed and falls back after one retry", async () => {
	await withChain(
		(callModel) => callModel.provider === "anthropic"
			? Promise.reject(new Error("Classifier request timed out after 20000 ms."))
			: reply("0"),
		async (ctx, calls) => {
			const result = await defaultClassifyAction(ctx, CONFIG, CLASSIFIER_ACTION, "");
			assert.equal(result.decision, "allow");
			assert.deepEqual(calls, ["anthropic/haiku", "anthropic/haiku", "github-copilot/haiku"]);
			assert.equal(result.io?.attempts[0]?.errorKind, "timeout");
		},
	);
});

test("a policy block from the classifier is a decision, not a failure, and is not retried elsewhere", async () => {
	const block = { decision: "block", tier: "soft_deny", reason: "outside scope" };
	await withChain(
		(_model, callIndex) => callIndex === 0
			? reply("1")
			: ({
				...reply("", "toolUse"),
				content: [{ type: "toolCall", id: "1", name: "classifier_decision", arguments: block }],
			}) as AssistantMessage,
		async (ctx, calls) => {
			const result = await defaultClassifyAction(ctx, CONFIG, CLASSIFIER_ACTION, "");
			assert.equal(result.decision, "block");
			assert.equal(result.tier, "soft_deny");
			assert.equal(result.failure, undefined);
			assert.deepEqual(calls, ["anthropic/haiku", "anthropic/haiku"]);
		},
	);
});

function hookDecision(failure?: { kind: "rate_limit"; message: string }) {
	return async () => ({
		decision: "block" as const,
		tier: "none" as const,
		reason: "classifier unavailable (rate limited, retry in 53m)",
		...(failure ? { failure } : {}),
	});
}

test("the tool hook reports an unavailable classifier as its own kind, not a policy denial", async () => {
	const hook = await setupHookTest({ classifier: hookDecision({ kind: "rate_limit", message: "429" }) });
	const result = await hook.emit("tool_call", { toolName: "bash", input: { command: "npm publish" } }, hook.ctx) as { block?: boolean; reason?: string };
	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /classifier unavailable \(rate limited, retry in 53m\)/);
	assert.match(result.reason ?? "", /not a policy denial/);
	assert.match(result.reason ?? "", /Do not claim success/);
	const state = hook.entries.at(-1)?.data;
	assert.equal(state.recentDenials.at(-1).kind, "classifier-unavailable");
	assert.equal(state.blockedActions, 1);
	assert.equal(state.classifierDenied, 0);
	const notification = hook.ctx.notifications.at(-1)?.message ?? "";
	assert.match(notification, /Auto mode blocked bash: classifier unavailable/);
});

test("a classifier policy block keeps kind classifier and counts as a classifier denial", async () => {
	const hook = await setupHookTest({ classifier: async () => ({ decision: "block", tier: "soft_deny", reason: "outside scope" }) });
	const result = await hook.emit("tool_call", { toolName: "bash", input: { command: "npm publish" } }, hook.ctx) as { block?: boolean; reason?: string };
	assert.equal(result.block, true);
	assert.doesNotMatch(result.reason ?? "", /not a policy denial/);
	const state = hook.entries.at(-1)?.data;
	assert.equal(state.recentDenials.at(-1).kind, "classifier");
	assert.equal(state.classifierDenied, 1);
});

test("the unavailable notice does not double the period of a reason that already ends a sentence", async () => {
	for (const reason of ["No classifier model/API key available; auto mode fails closed.", "classifier unavailable (rate limited, retry in 53m)"]) {
		const hook = await setupHookTest({
			classifier: async () => ({ decision: "block", tier: "none", reason, failure: { kind: "auth", message: reason } }),
		});
		const result = await hook.emit("tool_call", { toolName: "bash", input: { command: "npm publish" } }, hook.ctx) as { reason?: string };
		const text = result.reason ?? "";
		assert.ok(text.includes(`${reason.replace(/\.$/, "")}. This is not a policy denial`), text);
		assert.ok(!text.includes(".."), text);
	}
});
