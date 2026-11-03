import test from "node:test";
import assert from "node:assert/strict";
import { AUTO_MODE_GUIDANCE, createPiAutomode, type EffectiveConfig, STATE_ENTRY } from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

const BASH_CALL = { toolName: "bash", input: { command: "git push origin main" } };
const INSPECT_CALL = { toolName: "automode_inspect", input: { action: "status" } };
const NOT_INITIALIZED = "Extension runtime not initialized. Action methods cannot be called during extension loading.";

type LoadConfig = (cwd: string, projectTrusted: boolean) => EffectiveConfig;
type ToolCall = { toolName: string; input: unknown };

type Session = {
	pi: any;
	entries: any[];
	ctx: any;
	emit(event: string, payload: unknown, ctx: unknown): Promise<unknown>;
	command(args: string): unknown;
	toolCall(call?: ToolCall): Promise<{ blocked: boolean; classifierCalls: number }>;
};

function createSession(options: {
	sessionFile: string;
	sessionId: string;
	agent: { kind: "main" | "sub"; id?: string };
	parentSession?: string;
	entries?: unknown[];
	loadConfig?: LoadConfig;
	ctx?: Record<string, unknown>;
}): Session {
	const fake = createFakePi();
	fake.entries.push(...(options.entries ?? []));
	let classifierCalls = 0;
	createPiAutomode({
		loadConfig: options.loadConfig ?? (() => baseConfig()),
		classifyAction: async () => {
			classifierCalls += 1;
			return { decision: "block", tier: "thinking", reason: "test block" };
		},
	})(fake.pi);
	const ctx = createFakeCtx(fake.entries, {
		sessionFile: options.sessionFile,
		sessionId: options.sessionId,
		parentSession: options.parentSession,
		agent: options.agent,
		hasUI: options.agent.kind === "main",
		...options.ctx,
	});
	return {
		...fake,
		ctx,
		command: (args: string) => fake.commands.get("automode")?.handler(args, ctx),
		toolCall: async (call: ToolCall = BASH_CALL) => {
			const result = await fake.emit("tool_call", call, ctx) as { block?: boolean } | undefined;
			return { blocked: result?.block === true, classifierCalls };
		},
	};
}

async function startMain(sessionFile: string, sessionId: string): Promise<Session> {
	const main = createSession({ sessionFile, sessionId, agent: { kind: "main", id: "Main" } });
	await main.emit("session_start", { type: "session_start" }, main.ctx);
	return main;
}

// OMP's /tan never calls initializeExtensions: the clone gets no `session_start`,
// no UI, no model, and runtime actions such as `appendEntry` and `getAllTools`
// throw. Its header names the parent by session id, not by file.
function createTanClone(options: {
	sessionFile: string;
	sessionId: string;
	parentSession: string;
	entries?: unknown[];
	loadConfig?: LoadConfig;
	ctx?: Record<string, unknown>;
}): Session {
	const clone = createSession({
		...options,
		agent: { kind: "sub", id: "Tan-1" },
		ctx: { model: undefined, ...options.ctx },
	});
	const notInitialized = () => {
		throw new Error(NOT_INITIALIZED);
	};
	clone.pi.appendEntry = notInitialized;
	clone.pi.getAllTools = notInitialized;
	return clone;
}

test("a /tan clone follows the parent's /automode off and on without session_start", async () => {
	const main = await startMain("/sessions/tan.jsonl", "parent-id");
	await main.command("off");
	const clone = createTanClone({
		sessionFile: "/sessions/tan/Tan-1.jsonl",
		sessionId: "clone-id",
		parentSession: "parent-id",
	});

	assert.deepEqual(await clone.toolCall(), { blocked: false, classifierCalls: 0 });

	await main.command("on");
	assert.deepEqual(await clone.toolCall(), { blocked: true, classifierCalls: 1 });
});

test("a /tan clone enforces auto mode when the parent has not turned it off", async () => {
	await startMain("/sessions/tan-on.jsonl", "parent-on-id");
	const clone = createTanClone({
		sessionFile: "/sessions/tan-on/Tan-1.jsonl",
		sessionId: "clone-on-id",
		parentSession: "parent-on-id",
	});

	// The block comes from the classifier, not from a failing persist().
	const result = await clone.emit("tool_call", BASH_CALL, clone.ctx) as { block?: boolean; reason?: string };
	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /test block/);
	assert.equal(clone.entries.length, 0);
});

test("nested subagents of a /tan clone follow the main session by session file", async () => {
	const main = await startMain("/sessions/nest.jsonl", "nest-parent-id");
	await main.command("off");
	const clone = createTanClone({
		sessionFile: "/sessions/nest/Tan-1.jsonl",
		sessionId: "nest-clone-id",
		parentSession: "nest-parent-id",
	});
	await clone.toolCall();
	const worker = createSession({
		sessionFile: "/sessions/nest/Tan-1/Worker.jsonl",
		sessionId: "nest-worker-id",
		agent: { kind: "sub", id: "Worker" },
		parentSession: "/sessions/nest/Tan-1.jsonl",
	});
	await worker.emit("session_start", { type: "session_start" }, worker.ctx);

	assert.deepEqual(await worker.toolCall(), { blocked: false, classifierCalls: 0 });
});

test("a subagent started with session_start can also name its parent by session id", async () => {
	const main = await startMain("/sessions/by-id.jsonl", "by-id-parent");
	await main.command("off");
	const sub = createSession({
		sessionFile: "/sessions/by-id/Worker.jsonl",
		sessionId: "by-id-worker",
		agent: { kind: "sub", id: "Worker" },
		parentSession: "by-id-parent",
	});
	await sub.emit("session_start", { type: "session_start" }, sub.ctx);

	assert.deepEqual(await sub.toolCall(), { blocked: false, classifierCalls: 0 });
});

test("sessions that are not subagents ignore a parent session id", async () => {
	const main = await startMain("/sessions/id-fork.jsonl", "id-fork-parent");
	await main.command("off");
	const fork = createSession({
		sessionFile: "/sessions/id-fork-2.jsonl",
		sessionId: "id-fork-child",
		agent: { kind: "main", id: "Main" },
		parentSession: "id-fork-parent",
	});
	await fork.emit("session_start", { type: "session_start" }, fork.ctx);

	assert.deepEqual(await fork.toolCall(), { blocked: true, classifierCalls: 1 });
});

test("a session released on shutdown can no longer be adopted by id or file", async () => {
	const main = await startMain("/sessions/released.jsonl", "released-parent");
	await main.command("off");
	await main.emit("session_shutdown", { type: "session_shutdown" }, main.ctx);

	for (const parentSession of ["released-parent", "/sessions/released.jsonl"]) {
		const clone = createTanClone({
			sessionFile: `/sessions/released/Tan-${parentSession.length}.jsonl`,
			sessionId: `released-clone-${parentSession.length}`,
			parentSession,
		});
		assert.deepEqual(await clone.toolCall(), { blocked: true, classifierCalls: 1 });
	}
});

test("a session without session_start loads config for its own cwd and trust on first use", async () => {
	const loads: Array<{ cwd: string; trusted: boolean }> = [];
	const clone = createTanClone({
		sessionFile: "/sessions/cwd/Tan-1.jsonl",
		sessionId: "cwd-clone",
		parentSession: "missing-parent",
		loadConfig: (cwd, trusted) => {
			loads.push({ cwd, trusted });
			return baseConfig();
		},
		ctx: { cwd: "/work/project", isProjectTrusted: () => true },
	});
	const factoryLoads = loads.length;

	await clone.toolCall();
	await clone.toolCall();

	assert.deepEqual(loads.slice(factoryLoads), [{ cwd: "/work/project", trusted: true }]);
});

test("project config reaches a session that never got session_start", async () => {
	const clone = createTanClone({
		sessionFile: "/sessions/project/Tan-1.jsonl",
		sessionId: "project-clone",
		parentSession: "missing-parent",
		loadConfig: (cwd) => baseConfig({ enabled: cwd !== "/work/project" }),
		ctx: { cwd: "/work/project" },
	});

	assert.deepEqual(await clone.toolCall(), { blocked: false, classifierCalls: 0 });
});

test("a session without session_start restores the persisted enabled state", async () => {
	const clone = createTanClone({
		sessionFile: "/sessions/restore/Tan-1.jsonl",
		sessionId: "restore-clone",
		parentSession: "parent-not-in-this-process",
		entries: [{
			type: "custom",
			customType: STATE_ENTRY,
			data: {
				checkedActions: 3,
				blockedActions: 1,
				classifierAllowed: 0,
				classifierDenied: 0,
				recentDenials: [],
				enabledOverride: false,
			},
		}],
	});

	assert.deepEqual(await clone.toolCall(), { blocked: false, classifierCalls: 0 });
});

test("a session that got session_start is not initialised again on first use", async () => {
	let loads = 0;
	const main = createSession({
		sessionFile: "/sessions/once.jsonl",
		sessionId: "once-id",
		agent: { kind: "main", id: "Main" },
		loadConfig: () => {
			loads += 1;
			return baseConfig();
		},
	});
	await main.emit("session_start", { type: "session_start" }, main.ctx);
	const afterStart = loads;

	await main.toolCall();
	await main.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: {} }, main.ctx);

	assert.equal(loads, afterStart);
});

test("a session initialised on first use is initialised again by a later session_start", async () => {
	let loads = 0;
	const session = createSession({
		sessionFile: "/sessions/late.jsonl",
		sessionId: "late-id",
		agent: { kind: "main", id: "Main" },
		loadConfig: () => {
			loads += 1;
			return baseConfig();
		},
	});
	await session.toolCall();
	const afterLazy = loads;
	await session.emit("session_start", { type: "session_start" }, session.ctx);

	assert.equal(loads, afterLazy + 1);
	await session.toolCall();
	assert.equal(session.entries.some((entry) => entry.customType === STATE_ENTRY), true);
});

test("the first before_agent_start of a clone follows the parent's /automode off", async () => {
	const main = await startMain("/sessions/guidance-off.jsonl", "guidance-off-parent");
	await main.command("off");
	const clone = createTanClone({
		sessionFile: "/sessions/guidance-off/Tan-1.jsonl",
		sessionId: "guidance-off-clone",
		parentSession: "guidance-off-parent",
	});

	const result = await clone.emit("before_agent_start", { systemPrompt: "base", systemPromptOptions: {} }, clone.ctx);

	assert.equal(result, undefined);
});

test("guidance is not appended to a prompt that already carries it", async () => {
	const main = await startMain("/sessions/guidance.jsonl", "guidance-parent");
	const copied = `base prompt\n\n${AUTO_MODE_GUIDANCE}`;

	const result = await main.emit(
		"before_agent_start",
		{ systemPrompt: copied, systemPromptOptions: {} },
		main.ctx,
	);

	assert.equal(result, undefined);
});

test("guidance extends a prompt without it once", async () => {
	const main = await startMain("/sessions/guidance-once.jsonl", "guidance-once-parent");

	const result = await main.emit(
		"before_agent_start",
		{ systemPrompt: "base prompt", systemPromptOptions: {} },
		main.ctx,
	) as { systemPrompt: string };

	assert.equal(result.systemPrompt, `base prompt\n\n${AUTO_MODE_GUIDANCE}`);
});

test("OMP block-array system prompts keep their blocks and get the guidance as its own block", async () => {
	const main = await startMain("/sessions/guidance-array.jsonl", "guidance-array-parent");

	const result = await main.emit(
		"before_agent_start",
		{ systemPrompt: ["first block", "second block"], systemPromptOptions: {} },
		main.ctx,
	) as { systemPrompt: string[] };

	assert.deepEqual(result.systemPrompt, ["first block", "second block", AUTO_MODE_GUIDANCE]);
});

test("OMP block-array system prompts that already carry the guidance are left alone", async () => {
	const main = await startMain("/sessions/guidance-array-2.jsonl", "guidance-array-2-parent");

	const result = await main.emit(
		"before_agent_start",
		{ systemPrompt: ["first block", `copied\n\n${AUTO_MODE_GUIDANCE}`], systemPromptOptions: {} },
		main.ctx,
	);

	assert.equal(result, undefined);
});

test("the inspection tool is reviewed like any other tool when OMP cannot list tools", async () => {
	const clone = createTanClone({
		sessionFile: "/sessions/inspect/Tan-1.jsonl",
		sessionId: "inspect-clone",
		parentSession: "missing-parent",
	});

	const result = await clone.emit("tool_call", INSPECT_CALL, clone.ctx) as { block?: boolean; reason?: string };

	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /test block/);
});
