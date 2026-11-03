import test from "node:test";
import assert from "node:assert/strict";
import {
	hubAgentIdentity,
	createHubEntry,
	createPiAutomode,
	globalHubRegistry,
	hubActivityText,
	hubAgentId,
	type HubRegistry,
} from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

type Ref = {
	id: string;
	displayName: string;
	kind: string;
	parentId?: string;
	session: null;
	sessionFile: null;
	status: string;
	activity?: string;
	createdAt: number;
};

/** In-memory stand-in for OMP's AgentRegistry: same keyed-by-id overwrite and expected-ref unregister. */
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
			if (!ref || (expected !== undefined && ref !== expected)) {
				return false;
			}
			refs.delete(id);
			return true;
		},
	};
	return { registry, refs };
}

const MAIN = { kind: "main", id: "Main", name: "main" };
const SUB = { kind: "sub", id: "Pr32Drawbacks", name: "task" };

test("hubAgentId names the main agent by name and subagents by spawn id", () => {
	assert.equal(hubAgentId(MAIN), "main-automode");
	assert.equal(hubAgentId(SUB), "Pr32Drawbacks-automode");
});

test("hubAgentIdentity reads OMP's ctx.agent and rejects anything else", () => {
	assert.deepEqual(hubAgentIdentity({ agent: MAIN }), MAIN);
	assert.equal(hubAgentIdentity({}), undefined);
	assert.equal(hubAgentIdentity({ agent: null }), undefined);
	assert.equal(hubAgentIdentity({ agent: { kind: "main" } }), undefined);
});

test("globalHubRegistry is undefined without pi.pi.AgentRegistry (Pi)", () => {
	assert.equal(globalHubRegistry({}), undefined);
	assert.equal(globalHubRegistry({ pi: {} }), undefined);
	assert.equal(globalHubRegistry({ pi: { AgentRegistry: {} } }), undefined);
	assert.equal(globalHubRegistry({ pi: { AgentRegistry: { global: () => ({}) } } }), undefined);
});

test("globalHubRegistry returns the global registry on OMP", () => {
	const { registry } = createMockRegistry();
	assert.equal(globalHubRegistry({ pi: { AgentRegistry: { global: () => registry } } }), registry);
});

test("hubActivityText joins pretty-printed JSON into one line", () => {
	assert.equal(
		hubActivityText("allowed", "bash", 'bash {\n  "command": "ls"\n}'),
		'allowed bash { "command": "ls" }',
	);
});

test("hubActivityText collapses whitespace and control characters, and bounds the length", () => {
	assert.equal(
		hubActivityText("classifying", "bash", 'bash {"command":"echo\n\u001b[31mhi"}'),
		'classifying bash {"command":"echo [31mhi"}',
	);
	const long = hubActivityText("allowed", "write", `write ${"x".repeat(500)}`);
	assert.equal(long.length, 100);
	assert.ok(long.endsWith("…"));
});

test("createHubEntry registers a parked passive advisor ref parented to the agent", () => {
	const { registry, refs } = createMockRegistry();
	createHubEntry(registry, SUB);
	const ref = refs.get("Pr32Drawbacks-automode");
	assert.ok(ref);
	assert.equal(ref.displayName, "Pr32Drawbacks-automode");
	assert.equal(ref.kind, "advisor");
	assert.equal(ref.parentId, "Pr32Drawbacks");
	assert.equal(ref.session, null);
	assert.equal(ref.sessionFile, null);
	assert.equal(ref.status, "parked");
});

test("createHubEntry parents the main agent's ref to its id, not its name", () => {
	const { registry, refs } = createMockRegistry();
	createHubEntry(registry, MAIN);
	assert.equal(refs.get("main-automode")?.parentId, "Main");
});

test("a classifier call turns the ref running with the action, then back to parked with the decision", () => {
	const { registry, refs } = createMockRegistry();
	const entry = createHubEntry(registry, MAIN);
	const createdAt = refs.get("main-automode")?.createdAt;

	entry.classifyStarted("bash", 'bash {"command":"npm test"}');
	assert.equal(refs.get("main-automode")?.status, "running");
	assert.equal(refs.get("main-automode")?.activity, 'classifying bash {"command":"npm test"}');

	entry.classifyFinished();
	entry.decided("allow", "bash", 'bash {"command":"npm test"}');
	assert.equal(refs.get("main-automode")?.status, "parked");
	assert.equal(refs.get("main-automode")?.activity, 'allowed bash {"command":"npm test"}');
	assert.equal(refs.get("main-automode")?.createdAt, createdAt);
});

test("decisions made without the classifier update the resting activity", () => {
	const { registry, refs } = createMockRegistry();
	const entry = createHubEntry(registry, MAIN);
	entry.decided("block", "bash", 'bash {"command":"rm -rf /"}');
	assert.equal(refs.get("main-automode")?.status, "parked");
	assert.equal(refs.get("main-automode")?.activity, 'blocked bash {"command":"rm -rf /"}');
});

test("the ref stays running until the last overlapping classifier call finishes", () => {
	const { registry, refs } = createMockRegistry();
	const entry = createHubEntry(registry, MAIN);
	entry.classifyStarted("bash", "bash a");
	entry.classifyStarted("bash", "bash b");
	entry.classifyFinished();
	assert.equal(refs.get("main-automode")?.status, "running");
	entry.decided("allow", "bash", "bash a");
	assert.equal(refs.get("main-automode")?.status, "running");
	entry.classifyFinished();
	assert.equal(refs.get("main-automode")?.status, "parked");
	assert.equal(refs.get("main-automode")?.activity, "allowed bash a");
});

test("dispose unregisters the ref but leaves a newer registration of the same id alone", () => {
	const { registry, refs } = createMockRegistry();
	const first = createHubEntry(registry, MAIN);
	first.dispose();
	assert.equal(refs.size, 0);

	const stale = createHubEntry(registry, MAIN);
	const replacement = createHubEntry(registry, MAIN);
	stale.dispose();
	assert.equal(refs.get("main-automode")?.status, "parked");
	replacement.dispose();
	assert.equal(refs.size, 0);
});

async function startSession(agent: object | undefined, withRegistry = true) {
	const { registry, refs } = createMockRegistry();
	const fake = createFakePi();
	if (withRegistry) {
		(fake.pi as any).pi = { AgentRegistry: { global: () => registry } };
	}
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	createPiAutomode({
		loadConfig: () => baseConfig(),
		classifyAction: async () => {
			await gate;
			return { decision: "allow", tier: "none", reason: "ok" };
		},
	})(fake.pi);
	const ctx = createFakeCtx(fake.entries, agent ? { agent } : {});
	await fake.emit("session_start", { type: "session_start" }, ctx);
	return { ...fake, ctx, refs, release };
}

test("session_start registers the entry and session_shutdown removes it", async () => {
	const session = await startSession(MAIN);
	assert.equal(session.refs.get("main-automode")?.status, "parked");
	await session.emit("session_shutdown", { type: "session_shutdown" }, session.ctx);
	assert.equal(session.refs.size, 0);
});

test("a subagent session registers under its spawn id", async () => {
	const session = await startSession(SUB);
	assert.deepEqual([...session.refs.keys()], ["Pr32Drawbacks-automode"]);
});

test("a second session_start replaces the entry instead of leaking one", async () => {
	const session = await startSession(MAIN);
	await session.emit("session_start", { type: "session_start" }, session.ctx);
	assert.deepEqual([...session.refs.keys()], ["main-automode"]);
});

test("tool_call shows classifying in the hub while pending, then the decision", async () => {
	const session = await startSession(MAIN);
	const pending = session.emit("tool_call", {
		toolName: "bash",
		input: { command: "npm test" },
	}, session.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(session.refs.get("main-automode")?.status, "running");
	assert.match(session.refs.get("main-automode")?.activity ?? "", /^classifying bash .*npm test/);
	session.release();
	await pending;
	assert.equal(session.refs.get("main-automode")?.status, "parked");
	assert.match(session.refs.get("main-automode")?.activity ?? "", /^allowed bash .*npm test/);
});

test("a hard-deny shows as blocked in the hub without a classifier call", async () => {
	const session = await startSession(MAIN);
	await session.emit("tool_call", {
		toolName: "bash",
		input: { command: "rm -rf /" },
	}, session.ctx);
	assert.equal(session.refs.get("main-automode")?.status, "parked");
	assert.match(session.refs.get("main-automode")?.activity ?? "", /^blocked bash .*rm -rf/);
});

test("Pi sessions without pi.pi or ctx.agent register nothing and keep working", async () => {
	const withoutRegistry = await startSession(MAIN, false);
	assert.equal(withoutRegistry.refs.size, 0);
	const withoutAgent = await startSession(undefined);
	assert.equal(withoutAgent.refs.size, 0);
	withoutAgent.release();
	const result = await withoutAgent.emit("tool_call", {
		toolName: "bash",
		input: { command: "npm test" },
	}, withoutAgent.ctx);
	assert.equal(result, undefined);
});
