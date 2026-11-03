import test from "node:test";
import assert from "node:assert/strict";
import type { Api, AssistantMessage, Model } from "@earendil-works/pi-ai";
import {
	DEFAULT_OMP_CLASSIFIER_SELECTOR,
	createPiAutomode,
	defaultClassifyAction,
	describeClassifierModel,
	resolveClassifierModels,
	setOmpBridgeForTesting,
	statusText,
	type OmpBridge,
} from "../extensions/auto-mode.ts";
import { baseConfig, baseState, createFakeCtx, createFakePi } from "./test-helpers.ts";

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

function bridgeWith(chains: Record<string, Model<Api>[]>): OmpBridge & { requested: string[] } {
	const requested: string[] = [];
	return {
		requested,
		roleChain(role) {
			requested.push(role);
			return chains[role] ?? [];
		},
	};
}

function assistantWith(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	} satisfies AssistantMessage;
}

async function withBridge<T>(bridge: OmpBridge | undefined, run: () => Promise<T> | T): Promise<T> {
	setOmpBridgeForTesting(bridge);
	try {
		return await run();
	} finally {
		setOmpBridgeForTesting(undefined);
	}
}

const SMOL = [model("anthropic", "haiku"), model("github-copilot", "haiku"), model("openrouter", "flash")];
const SESSION = model("test", "session");

test("under OMP an unset classifierModel resolves the smol role chain", () => {
	const bridge = bridgeWith({ smol: SMOL });
	const resolved = resolveClassifierModels(createFakeCtx([], { model: SESSION }) as never, baseConfig(), bridge);
	assert.equal(resolved.selector, DEFAULT_OMP_CLASSIFIER_SELECTOR);
	assert.deepEqual(resolved.models, SMOL);
	assert.deepEqual(bridge.requested, ["smol"]);
});

test("an unset classifierModel falls back to the session model when smol resolves nothing or OMP is absent", () => {
	const ctx = createFakeCtx([], { model: SESSION }) as never;
	assert.deepEqual(resolveClassifierModels(ctx, baseConfig(), bridgeWith({})).models, [SESSION]);
	assert.deepEqual(resolveClassifierModels(ctx, baseConfig(), undefined), { models: [SESSION] });
});

test("role selectors resolve to that role's chain and never fall back to the session model", () => {
	const ctx = createFakeCtx([], { model: SESSION }) as never;
	const bridge = bridgeWith({ judge: [SMOL[1]!] });
	assert.deepEqual(resolveClassifierModels(ctx, baseConfig({ classifierModel: "@judge" }), bridge).models, [SMOL[1]]);
	const missing = resolveClassifierModels(ctx, baseConfig({ classifierModel: "@tiny" }), bridge);
	assert.deepEqual(missing.models, []);
	assert.match(missing.problem ?? "", /@tiny resolves to no available model/);
});

test("role selectors report a problem under Pi", () => {
	const resolved = resolveClassifierModels(
		createFakeCtx([], { model: SESSION }) as never,
		baseConfig({ classifierModel: "@smol" }),
		undefined,
	);
	assert.deepEqual(resolved.models, []);
	assert.match(resolved.problem ?? "", /@smol needs OMP model roles/);
});

test("provider/id selectors resolve through the registry and report unknown models", () => {
	const known = model("anthropic", "haiku");
	const ctx = createFakeCtx([], {
		modelRegistry: { find: (provider: string, id: string) => provider === "anthropic" && id === "haiku" ? known : undefined },
	}) as never;
	assert.deepEqual(resolveClassifierModels(ctx, baseConfig({ classifierModel: "anthropic/haiku" }), undefined).models, [known]);
	const unknown = resolveClassifierModels(ctx, baseConfig({ classifierModel: "anthropic/nope" }), undefined);
	assert.deepEqual(unknown.models, []);
	assert.match(unknown.problem ?? "", /model anthropic\/nope not found/);
});

test("describeClassifierModel shows the selector with its resolved model and fallback count", () => {
	const ctx = createFakeCtx([], { model: SESSION }) as never;
	const bridge = bridgeWith({ smol: SMOL, judge: [SMOL[0]!] });
	assert.equal(describeClassifierModel(ctx, baseConfig(), bridge), "@smol (default) → anthropic/haiku +2 fallbacks");
	assert.equal(describeClassifierModel(ctx, baseConfig({ classifierModel: "@judge" }), bridge), "@judge → anthropic/haiku");
	assert.equal(describeClassifierModel(ctx, baseConfig({ classifierModel: "@tiny" }), bridge), "@tiny (no available model)");
	assert.equal(describeClassifierModel(ctx, baseConfig({ classifierModel: "openai/gpt" }), bridge), "openai/gpt");
	assert.equal(describeClassifierModel(ctx, baseConfig(), undefined), "current session model");
});

test("statusText prints the resolved classifier description", () => {
	assert.match(statusText(baseConfig(), baseState(), "@smol (default) → a/b"), /^classifier: @smol \(default\) → a\/b$/m);
	assert.match(statusText(baseConfig({ classifierModel: "a/b" }), baseState()), /^classifier: a\/b$/m);
});

test("the classifier uses the first role-chain model that can authenticate", async () => {
	const calls: Array<{ model: Model<Api>; apiKey?: string }> = [];
	const ctx = createFakeCtx([], {
		model: SESSION,
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async (candidate: Model<Api>) =>
				candidate.provider === "anthropic"
					? { ok: false, error: "No API key for anthropic" }
					: { ok: true, apiKey: `key-${candidate.provider}` },
			async complete(callModel: Model<Api>, _context: unknown, options: { apiKey?: string }) {
				calls.push({ model: callModel, apiKey: options.apiKey });
				return assistantWith("0");
			},
		},
	});
	await withBridge(bridgeWith({ smol: SMOL }), async () => {
		const result = await defaultClassifyAction(ctx as never, baseConfig({ classifierModel: "@smol" }), '{"toolName":"bash","input":{}}', "");
		assert.equal(result.decision, "allow");
		assert.equal(result.io?.model, "github-copilot/haiku");
	});
	assert.equal(calls.length, 1);
	assert.equal(calls[0].model.provider, "github-copilot");
	assert.equal(calls[0].apiKey, "key-github-copilot");
});

test("an unset classifierModel under OMP classifies with the smol chain instead of the session model", async () => {
	const calls: Model<Api>[] = [];
	const ctx = createFakeCtx([], {
		model: SESSION,
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "k" }),
			async complete(callModel: Model<Api>) {
				calls.push(callModel);
				return assistantWith("0");
			},
		},
	});
	await withBridge(bridgeWith({ smol: SMOL }), async () => {
		const result = await defaultClassifyAction(ctx as never, baseConfig(), "{}", "");
		assert.equal(result.decision, "allow");
	});
	assert.deepEqual(calls.map((callModel) => `${callModel.provider}/${callModel.id}`), ["anthropic/haiku"]);
});

test("the classifier fails closed with the reason when a role resolves to no usable model", async () => {
	const ctx = createFakeCtx([], {
		modelRegistry: {
			find: () => undefined,
			getApiKeyAndHeaders: async () => ({ ok: false, error: "No API key" }),
		},
	});
	await withBridge(bridgeWith({ smol: SMOL }), async () => {
		const noAuth = await defaultClassifyAction(ctx as never, baseConfig({ classifierModel: "@smol" }), "{}", "");
		assert.equal(noAuth.decision, "block");
		assert.match(noAuth.reason, /No classifier model\/API key available \(anthropic\/haiku: No API key\); auto mode fails closed\./);
		const noModel = await defaultClassifyAction(ctx as never, baseConfig({ classifierModel: "@tiny" }), "{}", "");
		assert.equal(noModel.decision, "block");
		assert.match(noModel.reason, /@tiny resolves to no available model/);
	});
});

async function runModelCommand(argument: string, bridge: OmpBridge | undefined) {
	const saved: string[] = [];
	const fake = createFakePi();
	createPiAutomode({
		loadConfig: () => baseConfig(),
		saveClassifierModel: (classifierModel) => {
			saved.push(classifierModel);
		},
	})(fake.pi);
	const ctx = createFakeCtx(fake.entries);
	await withBridge(bridge, () => fake.commands.get("automode")!.handler(`model ${argument}`, ctx));
	return { saved, notifications: ctx.notifications };
}

test("/automode model saves an OMP role selector that resolves", async () => {
	const { saved } = await runModelCommand("@smol", bridgeWith({ smol: SMOL }));
	assert.deepEqual(saved, ["@smol"]);
});

test("/automode model rejects a role selector that resolves to nothing or needs OMP", async () => {
	const unresolved = await runModelCommand("@tiny", bridgeWith({}));
	assert.deepEqual(unresolved.saved, []);
	assert.match(unresolved.notifications.at(-1)?.message ?? "", /@tiny resolves to no available model/);
	const underPi = await runModelCommand("@smol", undefined);
	assert.deepEqual(underPi.saved, []);
	assert.match(underPi.notifications.at(-1)?.message ?? "", /@smol needs OMP model roles/);
});
