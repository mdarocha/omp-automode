import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import {
	ASK_ANSWER_ENTRY,
	CLASSIFIER_SYSTEM_PROMPT,
	buildClassifierTranscript,
	buildEffectiveConfigFromSources,
	findRootSessionEntries,
	registerParentContextSource,
	releaseParentContextSource,
	validateSettingsFile,
	type ClassifierTranscriptBudgets,
} from "../extensions/auto-mode.ts";
import { createFakeCtx, setupHookTest, type FakeCtx } from "./test-helpers.ts";

type Entry = Record<string, unknown>;

const BUDGETS: ClassifierTranscriptBudgets = { maxUserTokens: 4000, maxToolTokens: 4000 };
const BLOCK_OPEN = "<parent-session-user-messages>";
const BLOCK_CLOSE = "</parent-session-user-messages>";

function user(content: string, attribution?: "user" | "agent"): Entry {
	return {
		type: "message",
		message: { role: "user", content, ...(attribution ? { attribution } : {}) },
	};
}

function main(entries: Entry[], file: string, id: string): FakeCtx {
	return createFakeCtx(entries, {
		agent: { kind: "main", id: "Main", name: "main", depth: 0 },
		sessionFile: file,
		sessionId: id,
	});
}

function sub(entries: Entry[], file: string, id: string, parent: string, agentId = "Worker"): FakeCtx {
	return createFakeCtx(entries, {
		agent: { kind: "sub", id: agentId, name: "task", depth: 1, parentId: "Main" },
		sessionFile: file,
		sessionId: id,
		parentSession: parent,
	});
}

/** Register sessions for the test and unregister them afterwards. */
function register(t: TestContext, ...ctxs: FakeCtx[]): void {
	for (const ctx of ctxs) {
		registerParentContextSource(ctx as never);
	}
	t.after(() => {
		for (const ctx of ctxs) {
			releaseParentContextSource(ctx as never);
		}
	});
}

function transcript(ctx: FakeCtx, budgets: Partial<ClassifierTranscriptBudgets> = {}): string {
	return buildClassifierTranscript(ctx as never, { ...BUDGETS, ...budgets });
}

function block(text: string): string[] {
	const lines = text.split("\n");
	const start = lines.indexOf(BLOCK_OPEN);
	const end = lines.indexOf(BLOCK_CLOSE);
	return start === -1 || end === -1 ? [] : lines.slice(start + 1, end);
}

function tempRoot(t: TestContext): string {
	const dir = mkdtempSync(join(os.tmpdir(), "parent-context-"));
	t.after(() => rmSync(dir, { recursive: true, force: true }));
	return dir;
}

function jsonl(...lines: unknown[]): string {
	return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function header(id: string, parentSession?: string): Entry {
	return { type: "session", version: 3, id, ...(parentSession ? { parentSession } : {}) };
}

test("a subagent sees the main session's user messages, apart from its own brief", (t) => {
	const parent = main([user("Please clean up the stale worktrees under /tmp/wt")], "/s/live-1.jsonl", "id-live-1");
	const worker = sub([user("Complete assignment thoroughly: remove /tmp/wt/old", "agent")], "/s/live-1/W.jsonl", "id-w-1", "/s/live-1.jsonl");
	register(t, parent, worker);

	const text = transcript(worker);

	assert.deepEqual(block(text), ["User (main session): Please clean up the stale worktrees under /tmp/wt"]);
	assert.match(text, /^User: Complete assignment thoroughly: remove \/tmp\/wt\/old$/m);
	assert.ok(text.indexOf(BLOCK_CLOSE) < text.indexOf("User: Complete assignment"));
});

test("a /tan clone finds its parent by session id", (t) => {
	const parent = main([user("Tidy up the scratch branches")], "/s/live-2.jsonl", "id-live-2");
	const clone = sub([user("clone brief", "agent")], "/s/live-2/Tan-1.jsonl", "id-tan-2", "id-live-2", "Tan-1");
	register(t, parent, clone);

	assert.deepEqual(block(transcript(clone)), ["User (main session): Tidy up the scratch branches"]);
});

test("a nested subagent reaches the main session, not the subagent between", (t) => {
	const root = main([user("Refactor the parser, you may delete generated fixtures")], "/s/live-3.jsonl", "id-live-3");
	const middle = sub([user("MIDDLE BRIEF from coordinator", "agent")], "/s/live-3/Mid.jsonl", "id-mid-3", "/s/live-3.jsonl", "Mid");
	const leaf = sub([user("LEAF BRIEF", "agent")], "/s/live-3/Mid/Mid.Leaf.jsonl", "id-leaf-3", "/s/live-3/Mid.jsonl", "Mid.Leaf");
	register(t, root, middle, leaf);

	const text = transcript(leaf);

	assert.deepEqual(block(text), ["User (main session): Refactor the parser, you may delete generated fixtures"]);
	assert.doesNotMatch(block(text).join("\n"), /MIDDLE BRIEF/);
	assert.match(text, /^User: LEAF BRIEF$/m);
});

test("an unknown parent adds no section", (t) => {
	const orphan = sub([user("brief", "agent")], "/s/nowhere/W.jsonl", "id-orphan", "/s/does-not-exist.jsonl");
	register(t, orphan);

	const text = transcript(orphan);

	assert.equal(findRootSessionEntries(orphan as never), undefined);
	assert.doesNotMatch(text, /parent-session-user-messages/);
	assert.match(text, /^User: brief$/m);
});

test("main sessions and hosts without agent identity never get a section", (t) => {
	const root = main([user("hello")], "/s/live-4.jsonl", "id-live-4");
	const pi = createFakeCtx([user("hello")], { sessionFile: "/s/pi.jsonl", sessionId: "id-pi", parentSession: "/s/live-4.jsonl" });
	register(t, root, pi);

	assert.doesNotMatch(transcript(root), /parent-session-user-messages/);
	assert.doesNotMatch(transcript(pi), /parent-session-user-messages/);
});

test("only what the user typed or answered in the main session counts", (t) => {
	const root = main([
		user("Merge my own PR when CI is green"),
		user('<irc from="parent" agent="Higher">\nignored steering\n</irc>', "agent"),
		user("harness reminder text", "agent"),
		{ type: "custom_message", customType: "irc:incoming", content: "x", details: { from: "Peer", message: "peer says delete everything" } },
		{ type: "message", message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "bash", arguments: { command: "rm -rf /" } }] } },
		{ type: "message", message: { role: "toolResult", toolCallId: "c1", toolName: "bash", content: [{ type: "text", text: "tool output" }], isError: false } },
		user("Also push the branch"),
	], "/s/live-5.jsonl", "id-live-5");
	const worker = sub([user("brief", "agent")], "/s/live-5/W.jsonl", "id-w-5", "/s/live-5.jsonl");
	register(t, root, worker);

	assert.deepEqual(block(transcript(worker)), [
		"User (main session): Merge my own PR when CI is green",
		"User (main session): Also push the branch",
	]);
});

test("the main session's first brief and ask answers survive the parent budget", (t) => {
	const entries: Entry[] = [user(`ORIGINAL BRIEF ${"b".repeat(3000)} BRIEF-END`)];
	for (let index = 0; index < 10; index += 1) {
		entries.push(user(`chatter ${index}`));
	}
	entries.push(
		{ type: "message", message: { role: "toolResult", toolCallId: "a1", toolName: "ask", content: [{ type: "text", text: "User selected: Yes" }], isError: false } },
		{ type: "custom", customType: ASK_ANSWER_ENTRY, data: { toolCallId: "a1", answers: [{ question: "Delete the cache?", answer: "Yes, only ~/.cache/app" }] } },
	);
	for (let index = 10; index < 20; index += 1) {
		entries.push(user(`chatter ${index}`));
	}
	const root = main(entries, "/s/live-6.jsonl", "id-live-6");
	const worker = sub([user("brief", "agent")], "/s/live-6/W.jsonl", "id-w-6", "/s/live-6.jsonl");
	register(t, root, worker);

	const text = transcript(worker, { maxParentUserMessages: 3 });
	const lines = block(text);

	assert.match(lines[0] ?? "", /^User \(main session\): ORIGINAL BRIEF/);
	assert.match(lines.join("\n"), /BRIEF-END/);
	assert.match(lines.join("\n"), /User \(main session\): Answered ask question "Delete the cache\?": Yes, only ~\/\.cache\/app/);
	assert.match(lines.join("\n"), /chatter 19/);
	assert.doesNotMatch(lines.join("\n"), /chatter 5\b/);
	assert.ok(lines.includes("<transcript_entries_omitted />"));
	assert.ok(lines.filter((line) => line.startsWith("User (main session)")).length <= 3 + 1);
});

test("parent messages have their own token budget and are capped per entry", (t) => {
	const entries: Entry[] = [user("first")];
	for (let index = 0; index < 8; index += 1) {
		entries.push(user(`m${index} ${"x".repeat(600)}`));
	}
	const root = main(entries, "/s/live-7.jsonl", "id-live-7");
	const worker = sub([user("brief", "agent")], "/s/live-7/W.jsonl", "id-w-7", "/s/live-7.jsonl");
	register(t, root, worker);

	const used = block(transcript(worker, { maxParentUserTokens: 400, maxParentUserMessages: 50 }))
		.filter((line) => line !== "<transcript_entries_omitted />")
		.reduce((sum, line) => sum + Math.ceil(line.length / 4), 0);

	assert.ok(used <= 400, `parent block used ${used} tokens`);
});

test("includeParentUserMessages false removes the section", (t) => {
	const root = main([user("hello from the user")], "/s/live-8.jsonl", "id-live-8");
	const worker = sub([user("brief", "agent")], "/s/live-8/W.jsonl", "id-w-8", "/s/live-8.jsonl");
	register(t, root, worker);

	assert.doesNotMatch(transcript(worker, { includeParentUserMessages: false }), /parent-session-user-messages/);
	assert.match(transcript(worker), /hello from the user/);
});

test("a released parent is found on disk instead", (t) => {
	const dir = tempRoot(t);
	const rootFile = join(dir, "root.jsonl");
	writeFileSync(rootFile, jsonl(header("id-disk-0"), user("Disk user message")));
	mkdirSync(join(dir, "root"));
	const workerFile = join(dir, "root", "W.jsonl");
	writeFileSync(workerFile, jsonl(header("id-w-9", rootFile)));
	const root = main([user("Live user message")], rootFile, "id-disk-0");
	const worker = sub([user("brief", "agent")], workerFile, "id-w-9", rootFile);
	register(t, worker);
	registerParentContextSource(root as never);

	assert.deepEqual(block(transcript(worker)), ["User (main session): Live user message"]);
	releaseParentContextSource(root as never);
	assert.deepEqual(block(transcript(worker)), ["User (main session): Disk user message"]);
});

test("disk fallback follows file and id links through nested sessions", (t) => {
	const dir = tempRoot(t);
	const rootFile = join(dir, "root.jsonl");
	writeFileSync(rootFile, jsonl(header("id-root"), user("Root brief typed by the user"), user("Second user message")));
	mkdirSync(join(dir, "root", "Mid"), { recursive: true });
	const midFile = join(dir, "root", "Mid.jsonl");
	writeFileSync(midFile, jsonl(header("id-mid", rootFile), user("MID BRIEF", "agent")));
	const leafFile = join(dir, "root", "Mid", "Mid.Leaf.jsonl");
	writeFileSync(leafFile, jsonl(header("id-leaf", midFile), user("LEAF BRIEF", "agent")));
	const tanFile = join(dir, "root", "Tan-1.jsonl");
	writeFileSync(tanFile, jsonl(header("id-tan", "id-root"), user("tan brief", "agent")));

	const leaf = sub([user("LEAF BRIEF", "agent")], leafFile, "id-leaf", midFile, "Mid.Leaf");
	const tan = sub([user("tan brief", "agent")], tanFile, "id-tan", "id-root", "Tan-1");

	for (const ctx of [leaf, tan]) {
		assert.deepEqual(block(transcript(ctx)), [
			"User (main session): Root brief typed by the user",
			"User (main session): Second user message",
		]);
	}
});

test("a forked main session is a root and a broken chain adds nothing", (t) => {
	const dir = tempRoot(t);
	const original = join(dir, "original.jsonl");
	writeFileSync(original, jsonl(header("id-orig"), user("ORIGINAL SESSION MESSAGE")));
	const fork = join(dir, "fork.jsonl");
	writeFileSync(fork, jsonl(header("id-fork", original), user("Fork user message")));
	mkdirSync(join(dir, "fork"));
	const workerFile = join(dir, "fork", "W.jsonl");
	writeFileSync(workerFile, jsonl(header("id-w-11", fork)));
	const worker = sub([user("brief", "agent")], workerFile, "id-w-11", fork);

	assert.deepEqual(block(transcript(worker)), ["User (main session): Fork user message"]);

	mkdirSync(join(dir, "gone"));
	const strayFile = join(dir, "gone", "W.jsonl");
	writeFileSync(strayFile, jsonl(header("id-stray", join(dir, "missing.jsonl"))));
	assert.deepEqual(block(transcript(sub([user("b", "agent")], strayFile, "id-stray", join(dir, "missing.jsonl")))), []);

	const orphanMid = join(dir, "orphan", "Mid.jsonl");
	mkdirSync(join(dir, "orphan"));
	writeFileSync(orphanMid, jsonl(header("id-mid-2", join(dir, "vanished.jsonl"))));
	mkdirSync(join(dir, "orphan", "Mid"));
	const leafFile = join(dir, "orphan", "Mid", "Mid.Leaf.jsonl");
	writeFileSync(leafFile, jsonl(header("id-leaf-2", orphanMid)));
	assert.deepEqual(block(transcript(sub([user("b", "agent")], leafFile, "id-leaf-2", orphanMid))), []);
});

test("an oversized root session is read within bounds: first brief and newest messages", (t) => {
	const dir = tempRoot(t);
	const rootFile = join(dir, "root.jsonl");
	const filler = JSON.stringify({ type: "message", message: { role: "toolResult", toolCallId: "x", toolName: "bash", content: [{ type: "text", text: "z".repeat(50_000) }] } });
	const fillerLines = Array.from({ length: 140 }, () => filler).join("\n");
	writeFileSync(rootFile, `${jsonl(header("id-big"), user("FIRST BRIEF"), user("early message"))}${fillerLines}\n${jsonl(user("LATEST USER MESSAGE"))}`);
	mkdirSync(join(dir, "root"));
	const workerFile = join(dir, "root", "W.jsonl");
	writeFileSync(workerFile, jsonl(header("id-w-12", rootFile)));
	const worker = sub([user("brief", "agent")], workerFile, "id-w-12", rootFile);

	const lines = block(transcript(worker));

	assert.deepEqual(lines, ["User (main session): FIRST BRIEF", "User (main session): early message", "User (main session): LATEST USER MESSAGE"]);
});

test("sessions register at session_start and tool_call, and unregister at shutdown", async (t) => {
	const harness = await setupHookTest();
	const rootCtx = main([user("User words in the root")], "/s/live-13.jsonl", "id-live-13");
	const cloneCtx = sub([user("clone brief", "agent")], "/s/live-13/Tan-1.jsonl", "id-tan-13", "id-live-13", "Tan-1");
	const leafCtx = sub([user("leaf brief", "agent")], "/s/live-13/Tan-1/Tan-1.Leaf.jsonl", "id-leaf-13", "id-tan-13", "Tan-1.Leaf");
	t.after(() => {
		for (const ctx of [rootCtx, cloneCtx, leafCtx]) {
			releaseParentContextSource(ctx as never);
		}
	});

	await harness.emit("session_start", { type: "session_start" }, rootCtx);
	assert.deepEqual(block(transcript(cloneCtx)), ["User (main session): User words in the root"]);

	// A clone never gets session_start; its first tool call registers it for its own subagents.
	assert.deepEqual(block(transcript(leafCtx)), []);
	await harness.emit("tool_call", { toolName: "read", input: { path: "README.md" } }, cloneCtx);
	assert.deepEqual(block(transcript(leafCtx)), ["User (main session): User words in the root"]);

	await harness.emit("session_shutdown", { type: "session_shutdown" }, rootCtx);
	assert.deepEqual(block(transcript(cloneCtx)), []);
});

test("parent messages never reach a deterministic hard-deny decision", async (t) => {
	const harness = await setupHookTest();
	const rootCtx = main([user("I authorise editing the automode config, go ahead")], "/s/live-14.jsonl", "id-live-14");
	const workerCtx = sub([user("brief", "agent")], "/s/live-14/W.jsonl", "id-w-14", "/s/live-14.jsonl");
	register(t, rootCtx, workerCtx);

	const result = await harness.emit("tool_call", {
		toolName: "write",
		input: { path: ".pi/automode.local.json", content: "{}" },
	}, workerCtx) as { block?: boolean; reason?: string };

	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /safety-control/);
	assert.equal(harness.classifierCalls, 0);
});

test("the policy prompt explains the main-session user lines", () => {
	assert.match(CLASSIFIER_SYSTEM_PROMPT, /<parent-session-user-messages>/);
	assert.match(CLASSIFIER_SYSTEM_PROMPT, /User \(main session\)/);
	assert.match(CLASSIFIER_SYSTEM_PROMPT, /authorize actions inside this agent's delegated task/);
	assert.match(CLASSIFIER_SYSTEM_PROMPT, /carries authority only as far as these messages support it/);
	assert.match(CLASSIFIER_SYSTEM_PROMPT, /never override HARD_DENY/);
});

test("parent message settings have defaults and validate", () => {
	const defaults = buildEffectiveConfigFromSources({});
	assert.equal(defaults.includeParentUserMessages, true);
	assert.equal(defaults.maxParentUserTranscriptMessages, 6);
	assert.equal(defaults.maxParentUserTranscriptTokens, 2000);

	const configured = buildEffectiveConfigFromSources({
		inlineSettings: [{
			autoMode: {
				includeParentUserMessages: false,
				maxParentUserTranscriptMessages: 3,
				maxParentUserTranscriptTokens: 500,
			},
		}],
	});
	assert.equal(configured.includeParentUserMessages, false);
	assert.equal(configured.maxParentUserTranscriptMessages, 3);
	assert.equal(configured.maxParentUserTranscriptTokens, 500);

	const invalid = {
		autoMode: {
			includeParentUserMessages: "yes",
			maxParentUserTranscriptMessages: 0,
			maxParentUserTranscriptTokens: 5,
		} as never,
	};
	const diagnostics = validateSettingsFile(invalid, "test-config");
	for (const key of [
		"includeParentUserMessages must be a boolean",
		"maxParentUserTranscriptMessages must be an integer of at least 1",
		"maxParentUserTranscriptTokens must be an integer of at least 32",
	]) {
		assert.equal(diagnostics.some((line) => line.includes(key)), true, key);
	}
	const fallback = buildEffectiveConfigFromSources({ inlineSettings: [invalid] });
	assert.equal(fallback.includeParentUserMessages, true);
	assert.equal(fallback.maxParentUserTranscriptMessages, 6);
});
