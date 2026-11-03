import test from "node:test";
import assert from "node:assert/strict";
import { setImmediate as nextTick } from "node:timers/promises";
import {
	buildEffectiveConfigFromSources,
	createPiAutomode,
	DEFAULT_HEADLESS_ASK,
	defaultClassifyAction,
	type EffectiveConfig,
	FORWARDED_ASK_TIMEOUT_MS,
	type HeadlessAskMode,
	parseToolPattern,
	validateSettingsFile,
} from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

const ASK_RULE = "bash(git push*)";
const ASK_CALL = { toolName: "bash", input: { command: "git push origin feature" } };
const PERMISSION_ASK_KIND = "permissions.ask";

type ConfirmOptions = { signal?: AbortSignal };
type Confirm = (title: string, message: string, options?: ConfirmOptions) => Promise<boolean>;
type ConfirmRecord = { title: string; message: string; options?: ConfirmOptions };
type ClassifierCall = { action: string; notes: readonly string[] | undefined };
type AgentIdentity = { kind: "main" | "sub"; id: string };
type StateEntry = { customType?: string; data?: { recentDenials: Array<{ kind: string }> } };
type ClassifierRequest = { messages: Array<{ content: Array<{ text: string }> }> };
type ToolCallResult = { block?: boolean; reason?: string } | undefined;

type Session = {
	entries: StateEntry[];
	confirms: ConfirmRecord[];
	classifierCalls: ClassifierCall[];
	emit(event: string, payload: unknown): Promise<unknown>;
	toolCall(call?: { toolName: string; input: unknown }): Promise<{ block?: boolean; reason?: string } | undefined>;
};

function askConfig(overrides: Partial<EffectiveConfig> = {}): EffectiveConfig {
	const ask = parseToolPattern(ASK_RULE);
	assert.ok(ask);
	return baseConfig({ permissionAsk: [ask], ...overrides });
}

async function startSession(options: {
	sessionFile: string;
	sessionId: string;
	agent: AgentIdentity;
	hasUI: boolean;
	parentSession?: string;
	config?: EffectiveConfig;
	answer?: Confirm;
	signal?: AbortSignal;
	classifier?: "allow" | "block";
}): Promise<Session> {
	const fake = createFakePi();
	const classifierCalls: ClassifierCall[] = [];
	createPiAutomode({
		loadConfig: () => options.config ?? askConfig(),
		classifyAction: async (_ctx, _config, action, _loaded, notes) => {
			classifierCalls.push({ action, notes });
			return options.classifier === "block"
				? { decision: "block", tier: "soft_deny", reason: "classifier says no" }
				: { decision: "allow", tier: "none", reason: "classifier says yes" };
		},
	})(fake.pi);
	const confirms: ConfirmRecord[] = [];
	const confirm: Confirm = async (title, message, confirmOptions) => {
		confirms.push({ title, message, options: confirmOptions });
		return options.answer ? options.answer(title, message, confirmOptions) : true;
	};
	const ctx = createFakeCtx(fake.entries, {
		sessionFile: options.sessionFile,
		sessionId: options.sessionId,
		parentSession: options.parentSession,
		agent: options.agent,
		hasUI: options.hasUI,
		signal: options.signal,
		ui: { ...createFakeCtx().ui, confirm },
	});
	const emit = (event: string, payload: unknown) => fake.emit(event, payload, ctx);
	await emit("session_start", { type: "session_start" });
	return {
		entries: fake.entries,
		confirms,
		classifierCalls,
		emit,
		toolCall: async (call = ASK_CALL) => await emit("tool_call", call) as ToolCallResult,
	};
}

function startMain(id: string, answer?: Confirm): Promise<Session> {
	return startSession({
		sessionFile: `/sessions/${id}.jsonl`,
		sessionId: `${id}-id`,
		agent: { kind: "main", id: "Main" },
		hasUI: true,
		answer,
	});
}

function startWorker(
	parentId: string,
	options: Partial<Parameters<typeof startSession>[0]> = {},
): Promise<Session> {
	return startSession({
		sessionFile: `/sessions/${parentId}/Worker.jsonl`,
		sessionId: `${parentId}-worker-id`,
		agent: { kind: "sub", id: "Worker" },
		hasUI: false,
		parentSession: `/sessions/${parentId}.jsonl`,
		...options,
	});
}

test("a headless subagent forwards permissions.ask to its parent's UI and names itself", async () => {
	const main = await startMain("fwd");
	const worker = await startWorker("fwd");

	const result = await worker.toolCall();

	assert.equal(result, undefined);
	assert.equal(main.confirms.length, 1);
	assert.equal(worker.confirms.length, 0);
	assert.match(main.confirms[0]!.title, /Worker/);
	assert.match(main.confirms[0]!.message, /Rule: bash\(git push\*\)/);
	assert.match(main.confirms[0]!.message, /git push origin feature/);
	assert.match(main.confirms[0]!.message, /waits 25 seconds for an answer/);
	assert.equal(worker.classifierCalls.length, 1);
});

test("a forwarded approval still goes to the classifier and skips the allow tiers", async () => {
	await startMain("fwd-classifier");
	const allow = parseToolPattern("bash(*)");
	assert.ok(allow);
	const worker = await startWorker("fwd-classifier", {
		config: askConfig({ permissionAllow: [allow] }),
		classifier: "block",
	});

	const result = await worker.toolCall();

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /classifier says no/);
	assert.equal(worker.classifierCalls.length, 1);
	assert.deepEqual(worker.classifierCalls[0]!.notes, []);
});

test("declining the forwarded dialog blocks the subagent's call", async () => {
	const main = await startMain("fwd-decline", async () => false);
	const worker = await startWorker("fwd-decline");

	const result = await worker.toolCall();

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Declined permissions\.ask/);
	assert.equal(main.confirms.length, 1);
	assert.equal(worker.classifierCalls.length, 0);
});

test("a /tan-style subagent named by session id reaches its parent's UI", async () => {
	const main = await startMain("fwd-id");
	const clone = await startSession({
		sessionFile: "/sessions/fwd-id/Tan-1.jsonl",
		sessionId: "fwd-id-clone",
		agent: { kind: "sub", id: "Tan-1" },
		hasUI: false,
		parentSession: "fwd-id-id",
	});

	await clone.toolCall();

	assert.equal(main.confirms.length, 1);
	assert.match(main.confirms[0]!.title, /Tan-1/);
});

test("a nested headless subagent reaches the nearest ancestor with UI", async () => {
	const main = await startMain("fwd-nested");
	const worker = await startWorker("fwd-nested");
	const helper = await startSession({
		sessionFile: "/sessions/fwd-nested/Worker/Helper.jsonl",
		sessionId: "fwd-nested-helper-id",
		agent: { kind: "sub", id: "Helper" },
		hasUI: false,
		parentSession: "/sessions/fwd-nested/Worker.jsonl",
	});

	await helper.toolCall();

	assert.equal(main.confirms.length, 1);
	assert.match(main.confirms[0]!.title, /Helper/);
	assert.equal(worker.confirms.length, 0);
});

test("a subagent skips an intermediate headless session and uses the nearest UI", async () => {
	const main = await startMain("fwd-nearest");
	const worker = await startSession({
		sessionFile: "/sessions/fwd-nearest/Worker.jsonl",
		sessionId: "fwd-nearest-worker-id",
		agent: { kind: "sub", id: "Worker" },
		hasUI: true,
		parentSession: "/sessions/fwd-nearest.jsonl",
	});
	const helper = await startSession({
		sessionFile: "/sessions/fwd-nearest/Worker/Helper.jsonl",
		sessionId: "fwd-nearest-helper-id",
		agent: { kind: "sub", id: "Helper" },
		hasUI: false,
		parentSession: "/sessions/fwd-nearest/Worker.jsonl",
	});

	await helper.toolCall();

	assert.equal(worker.confirms.length, 1);
	assert.equal(main.confirms.length, 0);
});

test("a subagent whose parent is not registered in this process blocks", async () => {
	const worker = await startSession({
		sessionFile: "/sessions/fwd-orphan/Worker.jsonl",
		sessionId: "fwd-orphan-worker-id",
		agent: { kind: "sub", id: "Worker" },
		hasUI: false,
		parentSession: "/sessions/not-running.jsonl",
	});

	const result = await worker.toolCall();

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Matched permissions\.ask \(bash\(git push\*\)\).* but no UI is available/);
	assert.equal(worker.classifierCalls.length, 0);
});

test("a subagent blocks when no ancestor has UI", async () => {
	const print = await startSession({
		sessionFile: "/sessions/fwd-print.jsonl",
		sessionId: "fwd-print-id",
		agent: { kind: "main", id: "Main" },
		hasUI: false,
	});
	const worker = await startWorker("fwd-print");

	const result = await worker.toolCall();

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /but no UI is available/);
	assert.equal(print.confirms.length, 0);
});

test("a parent that shut down can no longer be asked", async () => {
	const main = await startMain("fwd-shutdown");
	const worker = await startWorker("fwd-shutdown");
	await main.emit("session_shutdown", { type: "session_shutdown" });

	const result = await worker.toolCall();

	assert.equal(result?.block, true);
	assert.equal(main.confirms.length, 0);
});

test("a fork of a UI session does not forward to its source session", async () => {
	const main = await startMain("fwd-fork");
	const fork = await startSession({
		sessionFile: "/sessions/fwd-fork-copy.jsonl",
		sessionId: "fwd-fork-copy-id",
		agent: { kind: "main", id: "Main" },
		hasUI: false,
		parentSession: "/sessions/fwd-fork.jsonl",
	});

	const result = await fork.toolCall();

	assert.equal(result?.block, true);
	assert.equal(main.confirms.length, 0);
});

test("the forwarded dialog carries the asking session's abort signal", async () => {
	const main = await startMain("fwd-signal");
	const controller = new AbortController();
	const worker = await startWorker("fwd-signal", { signal: controller.signal });

	await worker.toolCall();

	const dialogSignal = main.confirms[0]!.options?.signal;
	assert.ok(dialogSignal);
	assert.equal(dialogSignal.aborted, false);
	controller.abort();
	assert.equal(dialogSignal.aborted, true);
});

test("shutting down the asking session closes its pending forwarded dialog", async () => {
	let dialogSignal: AbortSignal | undefined;
	await startMain("fwd-close", (_title, _message, options) => {
		dialogSignal = options?.signal;
		const { promise, resolve } = Promise.withResolvers<boolean>();
		options?.signal?.addEventListener("abort", () => resolve(false), { once: true });
		return promise;
	});
	const worker = await startWorker("fwd-close");

	const pending = worker.toolCall();
	await nextTick();
	assert.equal(dialogSignal?.aborted, false);
	await worker.emit("session_shutdown", { type: "session_shutdown" });
	const result = await pending;

	assert.equal(dialogSignal?.aborted, true);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Declined permissions\.ask/);
});

test("an unanswered forwarded dialog closes at the deadline and blocks", async (t) => {
	t.mock.timers.enable({ apis: ["setTimeout"] });
	let dialogSignal: AbortSignal | undefined;
	await startMain("fwd-deadline", (_title, _message, options) => {
		dialogSignal = options?.signal;
		const { promise, resolve } = Promise.withResolvers<boolean>();
		options?.signal?.addEventListener("abort", () => resolve(false), { once: true });
		return promise;
	});
	const worker = await startWorker("fwd-deadline");

	const pending = worker.toolCall();
	await nextTick();
	t.mock.timers.tick(FORWARDED_ASK_TIMEOUT_MS - 1);
	assert.equal(dialogSignal?.aborted, false);
	t.mock.timers.tick(1);
	const result = await pending;

	assert.equal(dialogSignal?.aborted, true);
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /No answer from the parent session within 25s for permissions\.ask/);
	assert.equal(worker.classifierCalls.length, 0);
});

test("a parent dialog that throws blocks the call", async () => {
	await startMain("fwd-throw", async () => {
		throw new Error("ui disposed");
	});
	const worker = await startWorker("fwd-throw");

	const result = await worker.toolCall();

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /ui disposed/);
	assert.equal(worker.classifierCalls.length, 0);
});

test("headlessAsk block never consults a parent", async () => {
	const main = await startMain("mode-block");
	const worker = await startWorker("mode-block", { config: askConfig({ headlessAsk: "block" }) });

	const result = await worker.toolCall();

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /but no UI is available/);
	assert.equal(main.confirms.length, 0);
	assert.equal(worker.classifierCalls.length, 0);
});

test("headlessAsk classifier reviews the call with a note and skips the allow tiers", async () => {
	const main = await startMain("mode-classifier");
	const allow = parseToolPattern("bash(*)");
	assert.ok(allow);
	const worker = await startWorker("mode-classifier", {
		config: askConfig({ headlessAsk: "classifier", permissionAllow: [allow] }),
	});

	const result = await worker.toolCall();

	assert.equal(result, undefined);
	assert.equal(main.confirms.length, 0);
	assert.equal(worker.classifierCalls.length, 1);
	const notes = worker.classifierCalls[0]!.notes ?? [];
	assert.equal(notes.length, 1);
	assert.match(notes[0]!, /permissions\.ask/);
	assert.match(notes[0]!, /bash\(git push\*\)/);
	assert.match(notes[0]!, /no interactive UI/i);
});

test("headlessAsk classifier follows a classifier block", async () => {
	const worker = await startWorker("mode-classifier-block", {
		config: askConfig({ headlessAsk: "classifier" }),
		classifier: "block",
	});

	const result = await worker.toolCall();

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /classifier says no/);
});

test("headlessAsk classifier still obeys deterministic hard-deny checks", async () => {
	const ask = parseToolPattern("bash(*)");
	assert.ok(ask);
	const worker = await startWorker("mode-classifier-hard", {
		config: baseConfig({ permissionAsk: [ask], headlessAsk: "classifier" }),
	});

	const result = await worker.toolCall({ toolName: "bash", input: { command: "rm -rf /" } });

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /hard-denied/);
	assert.equal(worker.classifierCalls.length, 0);
});

test("a session with its own UI asks locally in every headlessAsk mode", async () => {
	for (const mode of ["parent", "classifier", "block"] as const satisfies readonly HeadlessAskMode[]) {
		const session = await startSession({
			sessionFile: `/sessions/local-${mode}.jsonl`,
			sessionId: `local-${mode}-id`,
			agent: { kind: "main", id: "Main" },
			hasUI: true,
			config: askConfig({ headlessAsk: mode }),
		});

		await session.toolCall();

		assert.equal(session.confirms.length, 1, mode);
		assert.equal(session.confirms[0]!.title, "Auto mode permission ask");
		assert.deepEqual(session.classifierCalls[0]!.notes, [], mode);
	}
});

test("the ask block is logged as permissions.ask", async () => {
	const worker = await startWorker("log-kind", { config: askConfig({ headlessAsk: "block" }) });

	await worker.toolCall();

	const denial = worker.entries
		.filter((entry) => entry.customType === "pi-automode-state")
		.at(-1)?.data?.recentDenials.at(-1);
	assert.equal(denial?.kind, PERMISSION_ASK_KIND);
});

test("headlessAsk defaults to parent and accepts only its three values", () => {
	assert.equal(DEFAULT_HEADLESS_ASK, "parent");
	assert.equal(buildEffectiveConfigFromSources({}).headlessAsk, "parent");
	for (const mode of ["parent", "classifier", "block"]) {
		const settings = { autoMode: { headlessAsk: mode as HeadlessAskMode } };
		assert.deepEqual(validateSettingsFile(settings, "test"), []);
		assert.equal(buildEffectiveConfigFromSources({ globalSettings: [settings] }).headlessAsk, mode);
	}

	const invalid = { autoMode: { headlessAsk: "always" } } as never;
	assert.deepEqual(validateSettingsFile(invalid, "test"), [
		"test: autoMode.headlessAsk must be one of parent, classifier, block",
	]);
	assert.equal(
		buildEffectiveConfigFromSources({
			globalSettings: [{ autoMode: { headlessAsk: "block" } }],
			projectLocalSettings: [invalid],
		}).headlessAsk,
		"block",
	);
});

test("headlessAsk follows scalar precedence and ignores shared project config", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { headlessAsk: "block" } }],
		projectLocalSettings: [{ autoMode: { headlessAsk: "classifier" } }],
		projectSharedSettings: [{ autoMode: { headlessAsk: "parent" } } as never],
	});
	assert.equal(config.headlessAsk, "classifier");

	const inline = buildEffectiveConfigFromSources({
		projectLocalSettings: [{ autoMode: { headlessAsk: "classifier" } }],
		inlineSettings: [{ autoMode: { headlessAsk: "block" } }],
	});
	assert.equal(inline.headlessAsk, "block");
});

test("the classifier context carries extension notes after the transcript", async () => {
	const calls: ClassifierRequest[] = [];
	const model = {
		provider: "test",
		id: "classifier",
		api: "test-api",
		reasoning: false,
		contextWindow: 128_000,
		maxTokens: 4096,
	};
	const ctx = createFakeCtx([], {
		model,
		modelRegistry: {
			find: () => model,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
			async complete(_model: unknown, context: ClassifierRequest) {
				calls.push(context);
				return {
					role: "assistant",
					content: [{ type: "text", text: "0" }],
					stopReason: "stop",
					timestamp: Date.now(),
					usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					api: "test-api",
					provider: "test",
					model: "classifier",
				};
			},
		},
	});
	const action = '{"toolName":"bash","input":{"command":"git push"}}';

	await defaultClassifyAction(ctx as never, baseConfig(), action, "", []);
	await defaultClassifyAction(ctx as never, baseConfig(), action, "", ["note one", "note two"]);

	assert.doesNotMatch(calls[0]!.messages[0]!.content[0]!.text, /extension-notes/);
	assert.match(calls[1]!.messages[0]!.content[0]!.text, /<classifier-transcript>[\s\S]*<\/classifier-transcript>\n\n<extension-notes>\n- note one\n- note two\n<\/extension-notes>$/);
});
