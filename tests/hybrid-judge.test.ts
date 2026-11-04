import test from "node:test";
import assert from "node:assert/strict";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	buildEffectiveConfigFromSources,
	classifierCooldowns,
	createPiAutomode,
	defaultClassifyAction,
	isClassifierStrategy,
	isJudgeConfidence,
	judgeVerdict,
	parseToolPattern,
	setOmpBridgeForTesting,
	statusText,
	validateSettingsFile,
	type ClassifyOptions,
	type JudgeOutcome,
	type JudgeProbabilities,
	type JudgeRequest,
	type JudgeKind,
	type OmpBridge,
	NO_CALIBRATED_JUDGE,
	withCalibratedJudge,
} from "../extensions/auto-mode.ts";
import { baseConfig, baseState, createFakeCtx, createFakePi } from "./test-helpers.ts";

const SAFE: JudgeProbabilities = { hard_deny: 0.01, soft_deny: 0.02, allow_exception: 0.1, direct_authorization: 0.1 };

test("the judge approves only when the safe side clears the confidence on every needed question", () => {
	assert.deepEqual(judgeVerdict(SAFE, 0.9).allow, true);
	assert.equal(judgeVerdict(SAFE, 0.9).tier, "none");
	// Exactly at the threshold approves; just under escalates.
	assert.equal(judgeVerdict({ ...SAFE, hard_deny: 0.1 }, 0.9).allow, true);
	assert.equal(judgeVerdict({ ...SAFE, hard_deny: 0.11 }, 0.9).allow, false);
	assert.equal(judgeVerdict({ ...SAFE, soft_deny: 0.1 }, 0.9).allow, true);
	assert.equal(judgeVerdict({ ...SAFE, soft_deny: 0.11 }, 0.9).allow, false);
	// A higher confidence demands a more certain judge.
	assert.equal(judgeVerdict(SAFE, 0.99).allow, false);
	assert.equal(judgeVerdict({ ...SAFE, hard_deny: 0.005, soft_deny: 0.005 }, 0.99).allow, true);
});

test("a soft deny is approved only through a confident exception or authorization", () => {
	const softDenied = { ...SAFE, soft_deny: 0.95 };
	assert.equal(judgeVerdict(softDenied, 0.9).allow, false);
	assert.match(judgeVerdict(softDenied, 0.9).reason, /soft_deny not ruled out/);
	assert.equal(judgeVerdict({ ...softDenied, allow_exception: 0.89 }, 0.9).allow, false);
	assert.deepEqual(
		[judgeVerdict({ ...softDenied, allow_exception: 0.95 }, 0.9).allow, judgeVerdict({ ...softDenied, allow_exception: 0.95 }, 0.9).tier],
		[true, "allow"],
	);
	assert.deepEqual(
		[judgeVerdict({ ...softDenied, direct_authorization: 0.95 }, 0.9).allow, judgeVerdict({ ...softDenied, direct_authorization: 0.95 }, 0.9).tier],
		[true, "explicit_intent"],
	);
});

test("a possible hard deny always escalates, whatever else the judge says", () => {
	const hardDenied = { hard_deny: 0.5, soft_deny: 0, allow_exception: 1, direct_authorization: 1 };
	const verdict = judgeVerdict(hardDenied, 0.9);
	assert.equal(verdict.allow, false);
	assert.match(verdict.reason, /hard_deny not ruled out/);
});

test("strategy and confidence settings validate, default, and apply", () => {
	assert.ok(isClassifierStrategy("hybrid") && isClassifierStrategy("staged") && isClassifierStrategy("detailed"));
	assert.ok(!isClassifierStrategy("fast") && !isClassifierStrategy(undefined));
	assert.ok(isJudgeConfidence(0.9) && isJudgeConfidence(1) && !isJudgeConfidence(0.5) && !isJudgeConfidence(1.1) && !isJudgeConfidence("0.9"));
	const defaults = buildEffectiveConfigFromSources({});
	assert.equal(defaults.classifierStrategy, "staged");
	assert.equal(defaults.judgeConfidence, 0.9);
	const configured = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { classifierStrategy: "hybrid", judgeConfidence: 0.95 } }],
	});
	assert.equal(configured.classifierStrategy, "hybrid");
	assert.equal(configured.judgeConfidence, 0.95);
	const bad = { autoMode: { classifierStrategy: "fast", judgeConfidence: 0.2 } } as never;
	assert.deepEqual(validateSettingsFile(bad, "t"), [
		"t: autoMode.classifierStrategy must be one of staged, detailed, hybrid",
		"t: autoMode.judgeConfidence must be a number above 0.5 and at most 1",
	]);
	assert.equal(buildEffectiveConfigFromSources({ globalSettings: [bad] }).classifierStrategy, "staged");
});

test("status reports the strategy, and the judge confidence only for hybrid", () => {
	assert.match(statusText(baseConfig(), baseState()), /^classifier strategy: staged$/m);
	assert.match(statusText(baseConfig({ classifierStrategy: "hybrid", judgeConfidence: 0.95 }), baseState()), /^classifier strategy: hybrid \(judge confidence 0.95\)$/m);
});

function model(provider: string, id: string): Model<Api> {
	// Only the fields the classifier reads exist on this fake model.
	return { provider, id, api: "test-api", reasoning: false, contextWindow: 128_000, maxTokens: 4096 } as unknown as Model<Api>;
}

function reply(text: string, stopReason = "stop"): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		timestamp: Date.now(),
	} as AssistantMessage;
}

function decisionReply(decision: string, tier: string, reason: string): AssistantMessage {
	return {
		...reply("", "toolUse"),
		content: [{ type: "toolCall", id: "1", name: "classifier_decision", arguments: { decision, tier, reason } }],
	} as AssistantMessage;
}

const COST = { input: 0.0001, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.0001 };
const JUDGE_USAGE = { input: 900, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 900, cost: COST };

type Harness = {
	ctx: ExtensionContext;
	requests: Array<{ detailed: boolean }>;
	judgeRequests: JudgeRequest[];
};

/** Runs `run` with a fake registry (classifier replies come from `classifier`) and a fake OMP bridge whose judge is `judge`. */
async function withHybrid<T>(
	classifier: (detailed: boolean) => AssistantMessage,
	judge: ((request: JudgeRequest) => Promise<JudgeOutcome>) | undefined,
	run: (harness: Harness) => Promise<T>,
): Promise<T> {
	const requests: Harness["requests"] = [];
	const judgeRequests: JudgeRequest[] = [];
	const classifierModel = model("anthropic", "haiku");
	const bridge: OmpBridge | undefined = judge
		? {
			roleChain: () => [classifierModel],
			judge: async (request) => {
				judgeRequests.push(request);
				return judge(request);
			},
		}
		: undefined;
	const ctx = createFakeCtx([], {
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
			async complete(_model: Model<Api>, context: { tools?: unknown[] }) {
				const detailed = Array.isArray(context.tools) && context.tools.length > 0;
				requests.push({ detailed });
				return classifier(detailed);
			},
		},
	}) as unknown as ExtensionContext;
	classifierCooldowns.clear();
	setOmpBridgeForTesting(bridge);
	try {
		return await run({ ctx, requests, judgeRequests });
	} finally {
		setOmpBridgeForTesting(undefined);
		classifierCooldowns.clear();
	}
}

const ACTION = '{"toolName":"bash","input":{"command":"echo ok"}}';
const outcome = (probabilities: JudgeProbabilities): JudgeOutcome => ({ model: "openrouter/typesafe/jev-1.14", probabilities, usage: JUDGE_USAGE });
const CLASSIFIER_ALLOW = (detailed: boolean) => detailed ? decisionReply("allow", "allow", "detailed ok") : reply("1");

test("staged runs the one-token gate first; detailed skips it", async () => {
	await withHybrid((detailed) => detailed ? decisionReply("allow", "none", "d") : reply("0"), async () => outcome(SAFE), async ({ ctx, requests }) => {
		const result = await defaultClassifyAction(ctx, baseConfig({ classifierStrategy: "staged", classifierModel: "@smol" }), ACTION, "");
		assert.equal(result.decision, "allow");
		assert.deepEqual(requests, [{ detailed: false }]);
	});
	await withHybrid((detailed) => detailed ? decisionReply("allow", "none", "d") : reply("0"), async () => outcome(SAFE), async ({ ctx, requests }) => {
		const result = await defaultClassifyAction(ctx, baseConfig({ classifierStrategy: "detailed", classifierModel: "@smol" }), ACTION, "");
		assert.equal(result.decision, "allow");
		assert.equal(result.reason, "d");
		assert.deepEqual(requests, [{ detailed: true }]);
		assert.deepEqual(result.io?.attempts.map((attempt) => attempt.stage), ["detailed"]);
	});
});

test("hybrid lets a confident judge approve without any classifier request, and records its usage", async () => {
	await withHybrid(CLASSIFIER_ALLOW, async () => outcome(SAFE), async ({ ctx, requests, judgeRequests }) => {
		const result = await defaultClassifyAction(ctx, baseConfig({ classifierStrategy: "hybrid", classifierModel: "@smol" }), ACTION, "");
		assert.equal(result.decision, "allow");
		assert.equal(result.failure, undefined);
		assert.match(result.reason, /^Judge openrouter\/typesafe\/jev-1\.14 cleared the action/);
		assert.deepEqual(requests, []);
		assert.equal(judgeRequests.length, 1);
		assert.deepEqual(Object.keys(judgeRequests[0]!.questions), ["hard_deny", "soft_deny", "allow_exception", "direct_authorization"]);
		assert.equal(judgeRequests[0]!.state.action, ACTION);
		const [attempt] = result.io?.attempts ?? [];
		assert.equal(attempt?.stage, "judge");
		assert.equal(attempt?.model, "openrouter/typesafe/jev-1.14");
		assert.equal(attempt?.response?.usage.cost.total, COST.total);
	});
});

test("hybrid escalates a doubtful judge to the detailed classifier on classifierModel", async () => {
	const doubtful = { ...SAFE, soft_deny: 0.5 };
	await withHybrid(CLASSIFIER_ALLOW, async () => outcome(doubtful), async ({ ctx, requests }) => {
		const result = await defaultClassifyAction(ctx, baseConfig({ classifierStrategy: "hybrid", classifierModel: "@smol" }), ACTION, "");
		assert.equal(result.decision, "allow");
		assert.equal(result.reason, "detailed ok");
		assert.deepEqual(requests, [{ detailed: true }], "no one-token gate after a judge");
		assert.deepEqual(result.io?.attempts.map((attempt) => attempt.stage), ["judge", "detailed"]);
		assert.match(result.io?.attempts[0]?.error ?? "", /^escalated: soft_deny not ruled out/);
	});
});

test("the judge never blocks: a judge that sees a hard deny still hands the decision to the classifier", async () => {
	const hardDenied = { ...SAFE, hard_deny: 0.99 };
	await withHybrid(() => decisionReply("block", "hard_deny", "classifier blocks"), async () => outcome(hardDenied), async ({ ctx, requests }) => {
		const result = await defaultClassifyAction(ctx, baseConfig({ classifierStrategy: "hybrid", classifierModel: "@smol" }), ACTION, "");
		assert.equal(result.decision, "block");
		assert.equal(result.reason, "classifier blocks");
		assert.equal(requests.length, 1);
	});
});

test("judge errors and an invalid probability escalate", async () => {
	for (const judge of [
		async (): Promise<JudgeOutcome> => {
			throw new Error("judgment: every judge candidate failed: 503");
		},
		async () => outcome({ ...SAFE, soft_deny: Number.NaN }),
		async () => outcome({ ...SAFE, hard_deny: 1.5 }),
	]) {
		await withHybrid(CLASSIFIER_ALLOW, judge, async ({ ctx, requests }) => {
			const result = await defaultClassifyAction(ctx, baseConfig({ classifierStrategy: "hybrid", classifierModel: "@smol" }), ACTION, "");
			assert.equal(result.decision, "allow");
			assert.equal(result.reason, "detailed ok");
			assert.deepEqual(requests, [{ detailed: true }]);
			assert.ok(result.io?.attempts[0]?.error, "the failed judge attempt is logged");
		});
	}
});

test("actions that skip the judge, and Pi without the bridge, go straight to the detailed classifier", async () => {
	await withHybrid(CLASSIFIER_ALLOW, async () => outcome(SAFE), async ({ ctx, requests, judgeRequests }) => {
		await defaultClassifyAction(ctx, baseConfig({ classifierStrategy: "hybrid", classifierModel: "@smol" }), ACTION, "", { skipJudge: true });
		assert.equal(judgeRequests.length, 0);
		assert.deepEqual(requests, [{ detailed: true }]);
	});
	await withHybrid(CLASSIFIER_ALLOW, undefined, async ({ ctx, requests }) => {
		const config = baseConfig({ classifierStrategy: "hybrid" });
		const piCtx = Object.assign(ctx, { model: model("test", "session") });
		const result = await defaultClassifyAction(piCtx, config, ACTION, "");
		assert.equal(result.decision, "allow");
		assert.deepEqual(requests, [{ detailed: true }]);
	});
});

test("the tool hook sends ask-forced and eval actions past the judge", async () => {
	const seen: Array<{ tool: string; options?: ClassifyOptions }> = [];
	const fake = createFakePi();
	const ask = parseToolPattern("bash(npm publish*)");
	assert.ok(ask);
	createPiAutomode({
		loadConfig: () => baseConfig({ classifierStrategy: "hybrid", permissionAsk: [ask] }),
		classifyAction: async (_ctx, _config, action, _loaded, options) => {
			seen.push({ tool: (JSON.parse(action) as { toolName: string }).toolName, options });
			return { decision: "allow", tier: "none", reason: "ok" };
		},
	})(fake.pi);
	const ctx = createFakeCtx(fake.entries);
	await fake.emit("session_start", { type: "session_start" }, ctx);
	await fake.emit("tool_call", { toolName: "bash", input: { command: "echo ok" } }, ctx);
	await fake.emit("tool_call", { toolName: "eval", input: { code: "1+1" } }, ctx);
	await fake.emit("tool_call", { toolName: "bash", input: { command: "npm publish" } }, ctx);
	assert.deepEqual(seen.map(({ tool, options }) => [tool, options?.skipJudge]), [["bash", false], ["eval", true], ["bash", true]]);
});

type FakeCandidate = { kind: JudgeKind; probabilities?: JudgeProbabilities; fail?: Error };

/** A judge chain like OMP's `ChainJudge`: tries each candidate, moving on after a throw. */
function fakeChain(candidates: FakeCandidate[], ran: JudgeKind[]) {
	return {
		async withCandidate<R>(run: (judge: FakeCandidate, kind: JudgeKind) => Promise<R>): Promise<R> {
			let last: unknown = new Error("judgment: no judge candidate");
			for (const candidate of candidates) {
				try {
					return await run(candidate, candidate.kind);
				} catch (error) {
					last = error;
				}
			}
			throw last;
		},
		ran,
	};
}

/** A bridge whose `judge` is the real calibrated-only selection over a fake chain. */
function bridgeOverChain(candidates: FakeCandidate[], ran: JudgeKind[]): (request: JudgeRequest) => Promise<JudgeOutcome> {
	const chain = fakeChain(candidates, ran);
	return (request) =>
		withCalibratedJudge(chain, async (candidate) => {
			ran.push(candidate.kind);
			if (candidate.fail) {
				throw candidate.fail;
			}
			return outcome(candidate.probabilities!);
		}, request.signal);
}

test("a chat judge never approves: its one-hot answer is skipped and the detailed classifier decides", async () => {
	const ran: JudgeKind[] = [];
	const oneHotSafe = { hard_deny: 0, soft_deny: 0, allow_exception: 0, direct_authorization: 0 };
	await withHybrid(CLASSIFIER_ALLOW, bridgeOverChain([{ kind: "online", probabilities: oneHotSafe }, { kind: "local", probabilities: oneHotSafe }], ran), async ({ ctx, requests }) => {
		const result = await defaultClassifyAction(ctx, baseConfig({ classifierStrategy: "hybrid", classifierModel: "@smol" }), ACTION, "");
		assert.deepEqual(ran, [], "no chat or local candidate was asked");
		assert.equal(result.reason, "detailed ok", "the classifier decided, not the judge");
		assert.deepEqual(requests, [{ detailed: true }]);
		assert.deepEqual(result.io?.attempts.map((attempt) => attempt.stage), ["judge", "detailed"]);
		assert.equal(result.io?.attempts[0]?.error, NO_CALIBRATED_JUDGE);
		assert.equal(NO_CALIBRATED_JUDGE, "judge-unavailable: no calibrated judge");
	});
});

test("a native judge above the threshold approves, even after a chat candidate was skipped", async () => {
	const ran: JudgeKind[] = [];
	await withHybrid(CLASSIFIER_ALLOW, bridgeOverChain([{ kind: "online", probabilities: SAFE }, { kind: "native", probabilities: SAFE }], ran), async ({ ctx, requests }) => {
		const result = await defaultClassifyAction(ctx, baseConfig({ classifierStrategy: "hybrid", classifierModel: "@smol" }), ACTION, "");
		assert.deepEqual(ran, ["native"]);
		assert.equal(result.decision, "allow");
		assert.match(result.reason, /^Judge openrouter\/typesafe\/jev-1\.14 cleared the action/);
		assert.deepEqual(requests, []);
	});
});

test("a native judge below the threshold escalates to the detailed classifier", async () => {
	const ran: JudgeKind[] = [];
	await withHybrid(CLASSIFIER_ALLOW, bridgeOverChain([{ kind: "native", probabilities: { ...SAFE, soft_deny: 0.5 } }], ran), async ({ ctx, requests }) => {
		const result = await defaultClassifyAction(ctx, baseConfig({ classifierStrategy: "hybrid", classifierModel: "@smol" }), ACTION, "");
		assert.deepEqual(ran, ["native"]);
		assert.equal(result.reason, "detailed ok");
		assert.deepEqual(requests, [{ detailed: true }]);
		assert.match(result.io?.attempts[0]?.error ?? "", /^escalated: soft_deny not ruled out/);
	});
});

test("a failing native judge keeps its own error; only a chain without a calibrated judge reports none", async () => {
	const boom = new Error("judgment: 503");
	await assert.rejects(
		withCalibratedJudge(fakeChain([{ kind: "online" }, { kind: "native" }], []), async () => {
			throw boom;
		}),
		boom,
	);
	await assert.rejects(withCalibratedJudge(fakeChain([{ kind: "online" }], []), async () => "x"), { message: NO_CALIBRATED_JUDGE });
	await assert.rejects(withCalibratedJudge(fakeChain([], []), async () => "x"), { message: NO_CALIBRATED_JUDGE });
	const aborted = AbortSignal.abort(new Error("timed out"));
	await assert.rejects(withCalibratedJudge(fakeChain([{ kind: "online" }], []), async () => "x", aborted), { message: /judge skipped|timed out/ });
});
