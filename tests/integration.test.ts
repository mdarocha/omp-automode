import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	createPiAutomode,
	decisionStage,
	parseToolPattern,
	type ClassifyAction,
	type EffectiveConfig,
	type HubRegistry,
} from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

// Cross-feature behaviour of the merged branches. OMP's `/tan` clones never get
// `session_start`, no UI, and runtime actions such as `appendEntry` throw.

const NOT_INITIALIZED = "Extension runtime not initialized. Action methods cannot be called during extension loading.";
const ASK_RULE = "bash(git push*)";
const PUSH = { toolName: "bash", input: { command: "git push origin feature" } };

type Ref = { id: string; kind: string; parentId?: string; status: string; activity?: string; createdAt: number };

function createMockRegistry() {
	const refs = new Map<string, Ref>();
	let clock = 1000;
	const registry: HubRegistry = {
		register(input) {
			const ref = { ...input, createdAt: input.createdAt ?? (clock += 1) } as Ref;
			refs.set(ref.id, ref);
			return ref;
		},
		unregister(id, expected) {
			const ref = refs.get(id);
			if (!ref || (expected !== undefined && ref !== expected)) return false;
			refs.delete(id);
			return true;
		},
	};
	return { registry, refs };
}

type StateEntry = {
	customType?: string;
	data?: {
		recentDenials: Array<{ kind: string }>;
		recentClassifierErrors: Array<{ kind: string; stage?: string; retryAfterMs?: number }>;
	};
};

type Session = {
	entries: StateEntry[];
	confirms: string[];
	emit(event: string, payload: unknown): Promise<unknown>;
};

function createSession(options: {
	sessionFile: string;
	sessionId: string;
	agent: { kind: "main" | "sub"; id: string; name: string; depth: number };
	parentSession?: string;
	hasUI: boolean;
	registry?: HubRegistry;
	config?: EffectiveConfig;
	classifyAction?: ClassifyAction;
	cwd?: string;
	/** Behave like a `/tan` clone: no model, and runtime actions throw. */
	clone?: boolean;
}): Session {
	const fake = createFakePi();
	if (options.registry) {
		const { registry } = options;
		Object.assign(fake.pi, { pi: { AgentRegistry: { global: () => registry } } });
	}
	createPiAutomode({
		loadConfig: () => options.config ?? baseConfig(),
		classifyAction: options.classifyAction ?? (async () => ({ decision: "allow", tier: "none", reason: "ok" })),
	})(fake.pi);
	if (options.clone) {
		const notInitialized = () => {
			throw new Error(NOT_INITIALIZED);
		};
		fake.pi.appendEntry = notInitialized;
		fake.pi.getAllTools = notInitialized;
	}
	const confirms: string[] = [];
	const base = createFakeCtx();
	const ctx = createFakeCtx(fake.entries, {
		sessionFile: options.sessionFile,
		sessionId: options.sessionId,
		parentSession: options.parentSession,
		agent: options.agent,
		hasUI: options.hasUI,
		cwd: options.cwd ?? "/tmp/project",
		...(options.clone ? { model: undefined } : {}),
		ui: {
			...base.ui,
			confirm: async (title: string) => {
				confirms.push(title);
				return true;
			},
		},
	});
	return {
		entries: fake.entries,
		confirms,
		emit: (event, payload) => fake.emit(event, payload, ctx),
	};
}

const MAIN = { kind: "main", id: "Main", name: "main", depth: 0 } as const;
const tan = (id: string) => ({ kind: "sub", id, name: "tan", depth: 0 }) as const;

test("a /tan clone that never got session_start shows up in the Agent Hub on its first hook call", async () => {
	const { registry, refs } = createMockRegistry();
	const clone = createSession({
		sessionFile: "/sessions/hub/Tan-7.jsonl",
		sessionId: "hub-clone",
		agent: tan("Tan-7"),
		parentSession: "hub-main",
		hasUI: false,
		registry,
		clone: true,
	});
	assert.equal(refs.size, 0);

	await clone.emit("tool_call", { toolName: "bash", input: { command: "echo hi" } });

	assert.deepEqual([...refs.keys()], ["Tan-7-automode"]);
	const ref = refs.get("Tan-7-automode")!;
	assert.equal(ref.kind, "advisor");
	assert.equal(ref.parentId, "Tan-7");
	assert.equal(ref.status, "parked");
	assert.match(ref.activity ?? "", /allowed bash/);
	assert.deepEqual(clone.entries, [], "memory-only state: nothing is persisted");
});

test("the hub entry of a first-use session is replaced by a later session_start, not duplicated", async () => {
	const { registry, refs } = createMockRegistry();
	const session = createSession({
		sessionFile: "/sessions/hub2/Tan-8.jsonl",
		sessionId: "hub2-clone",
		agent: tan("Tan-8"),
		hasUI: false,
		registry,
	});
	await session.emit("tool_call", { toolName: "bash", input: { command: "echo hi" } });
	await session.emit("session_start", { type: "session_start" });
	assert.deepEqual([...refs.keys()], ["Tan-8-automode"]);
	await session.emit("session_shutdown", { type: "session_shutdown" });
	assert.equal(refs.size, 0);
});

test("a subagent of a /tan clone forwards its ask through the clone to the main UI", async () => {
	const ask = parseToolPattern(ASK_RULE);
	assert.ok(ask);
	const config = baseConfig({ permissionAsk: [ask] });
	const main = createSession({
		sessionFile: "/sessions/chain/main.jsonl",
		sessionId: "chain-main",
		agent: MAIN,
		hasUI: true,
		config,
	});
	await main.emit("session_start", { type: "session_start" });
	const clone = createSession({
		sessionFile: "/sessions/chain/Tan-9.jsonl",
		sessionId: "chain-clone",
		agent: tan("Tan-9"),
		parentSession: "chain-main",
		hasUI: false,
		config,
		clone: true,
	});
	// The clone's first hook call registers it; no `session_start` ever runs.
	await clone.emit("tool_call", { toolName: "bash", input: { command: "echo hi" } });
	const helper = createSession({
		sessionFile: "/sessions/chain/Tan-9/Helper.jsonl",
		sessionId: "chain-helper",
		agent: { kind: "sub", id: "Helper", name: "task", depth: 1 },
		parentSession: "chain-clone",
		hasUI: false,
		config,
	});
	await helper.emit("session_start", { type: "session_start" });

	const result = await helper.emit("tool_call", PUSH);

	assert.equal(result, undefined);
	assert.equal(main.confirms.length, 1);
	assert.match(main.confirms[0]!, /Helper/);
});

test("a /tan clone tracks created paths in memory and never touches appendEntry", async () => {
	const base = mkdtempSync(join(os.tmpdir(), "automode-integration-"));
	try {
		const classifierCreated: Array<readonly string[] | undefined> = [];
		const clone = createSession({
			sessionFile: join(base, "Tan-10.jsonl"),
			sessionId: "prov-clone",
			agent: tan("Tan-10"),
			hasUI: false,
			cwd: base,
			clone: true,
			classifyAction: async (_ctx, _config, _action, _loaded, _notes, created) => {
				classifierCreated.push(created);
				return { decision: "allow", tier: "none", reason: "ok" };
			},
		});
		const command = `mkdir -p ${base}/bot/work`;
		assert.equal(await clone.emit("tool_call", { type: "tool_call", toolCallId: "c1", toolName: "bash", input: { command } }), undefined);
		mkdirSync(join(base, "bot", "work"), { recursive: true });
		await clone.emit("tool_result", {
			type: "tool_result",
			toolCallId: "c1",
			toolName: "bash",
			input: { command },
			content: [{ type: "text", text: "" }],
			details: undefined,
			isError: false,
		});

		await clone.emit("tool_call", { type: "tool_call", toolCallId: "c2", toolName: "bash", input: { command: `rm -rf ${base}/bot` } });

		assert.deepEqual(classifierCreated.at(-1), [join(base, "bot")]);
		assert.deepEqual(clone.entries, []);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("a classifier failure blocks as classifier-unavailable and reaches the typed error record without its message", async () => {
	const session = createSession({
		sessionFile: "/sessions/err/main.jsonl",
		sessionId: "err-main",
		agent: MAIN,
		hasUI: true,
		classifyAction: async () => ({
			decision: "block",
			tier: "none",
			reason: "classifier unavailable (rate limited)",
			failure: { kind: "rate-limit", stage: "detailed", retryAfterMs: 60_000, message: "PROVIDER-TEXT req_1" },
		}),
	});
	await session.emit("session_start", { type: "session_start" });

	const result = await session.emit("tool_call", { toolName: "bash", input: { command: "npm test" } }) as { block?: boolean };

	assert.equal(result.block, true);
	const state = session.entries.filter((entry) => entry.customType === "pi-automode-state").at(-1)?.data;
	assert.ok(state);
	assert.equal(state.recentDenials.at(-1)?.kind, "classifier-unavailable");
	assert.deepEqual(
		state.recentClassifierErrors.map((error) => [error.kind, error.stage, error.retryAfterMs]),
		[["rate-limit", "detailed", 60_000]],
	);
	assert.doesNotMatch(JSON.stringify(state), /PROVIDER-TEXT/);
});

test("the unavailable-classifier block text has no doubled period when the reason already ends in one", async () => {
	const session = createSession({
		sessionFile: "/sessions/dot/main.jsonl",
		sessionId: "dot-main",
		agent: MAIN,
		hasUI: true,
		classifyAction: async () => ({
			decision: "block",
			tier: "none",
			reason: "No classifier model/API key available (model x/y not found); auto mode fails closed.",
			failure: { kind: "no-classifier" },
		}),
	});
	await session.emit("session_start", { type: "session_start" });

	const result = await session.emit("tool_call", { toolName: "bash", input: { command: "npm test" } }) as { reason?: string };

	assert.match(result.reason ?? "", /fails closed\. This is not a policy denial/);
	assert.doesNotMatch(result.reason ?? "", /\.\./);
});

test("url-scheme decisions get their own enforcement stage", () => {
	assert.equal(decisionStage("url-scheme"), "url-scheme");
});

test("read-only bash and read-only root decisions log the read-only stage", () => {
	assert.equal(decisionStage("read-only-bash"), "read-only");
	assert.equal(decisionStage("read-only-root"), "read-only");
});
