import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { createPiAutomode, type EffectiveConfig } from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

type HookResult = { block?: boolean; reason?: string; input?: Record<string, unknown> } | undefined;
type ResultPatch = { isError?: boolean; content?: { text: string }[] } | undefined;

const BUILTIN_GREP = { path: "<builtin:grep>", source: "builtin" };

function makeTree(t: test.TestContext): string {
	const base = realpathSync(mkdtempSync(join(os.tmpdir(), "pi-automode-hook-scope-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	for (const file of ["README.md", "src/app.ts", "private/token.txt"]) {
		mkdirSync(join(base, file, ".."), { recursive: true });
		writeFileSync(join(base, file), "needle");
	}
	return base;
}

async function setup(base: string, config: EffectiveConfig, builtinGrep = true) {
	const fake = createFakePi();
	if (builtinGrep) {
		fake.pi.getAllTools = () => [{ name: "grep", sourceInfo: BUILTIN_GREP }];
	}
	let classifierCalls = 0;
	createPiAutomode({
		loadConfig: () => config,
		classifyAction: async () => {
			classifierCalls += 1;
			return { decision: "allow", tier: "none", reason: "classifier allow" };
		},
	})(fake.pi);
	const ctx = createFakeCtx(fake.entries, { cwd: base });
	await fake.emit("session_start", { type: "session_start" }, ctx);
	return {
		call: (toolName: string, toolCallId: string, input: Record<string, unknown>) =>
			fake.emit("tool_call", { toolName, toolCallId, input }, ctx) as Promise<HookResult>,
		result: (toolCallId: string, details: unknown, isError = false) =>
			fake.emit("tool_result", { toolName: "grep", toolCallId, details, isError, content: [] }, ctx) as Promise<ResultPatch>,
		get classifierCalls() { return classifierCalls; },
	};
}

test("built-in grep that can reach a denied path runs with exclusions appended", async (t) => {
	const base = makeTree(t);
	const harness = await setup(base, baseConfig({ deniedPaths: [`${base}/private/token.txt`] }));

	const result = await harness.call("grep", "t1", { pattern: "needle", path: "." });

	assert.equal(result?.block, undefined);
	assert.match(String(result?.input?.path), /^\.;!\*\*\/\[pP\]\[rR\]\[iI\]/);
	assert.equal(result?.input?.pattern, "needle");
	assert.equal(harness.classifierCalls, 0);
	assert.equal(await harness.result("t1", { files: ["README.md", "src/app.ts"] }), undefined);
});

test("a narrowed grep result that lists a denied file is dropped", async (t) => {
	const base = makeTree(t);
	for (const details of [{ files: ["README.md", "private/token.txt"] }, undefined, {}]) {
		const harness = await setup(base, baseConfig({ deniedPaths: [`${base}/private/token.txt`] }));
		await harness.call("grep", "t1", { pattern: "needle", path: "." });
		const patch = await harness.result("t1", details);
		assert.equal(patch?.isError, true, JSON.stringify(details));
		assert.match(patch?.content?.[0]?.text ?? "", /could not be verified against deniedPaths/);
	}
});

test("an errored narrowed grep result is left alone", async (t) => {
	const base = makeTree(t);
	const harness = await setup(base, baseConfig({ deniedPaths: [`${base}/private/token.txt`] }));
	await harness.call("grep", "t1", { pattern: "needle", path: "." });
	assert.equal(await harness.result("t1", undefined, true), undefined);
});

test("grep results the hook did not narrow are not verified", async (t) => {
	const base = makeTree(t);
	const harness = await setup(base, baseConfig({ deniedPaths: [`${base}/private/token.txt`] }));
	assert.equal(await harness.call("grep", "t1", { pattern: "needle", path: "src" }), undefined);
	assert.equal(await harness.result("t1", undefined), undefined);
});

test("without OMP's built-in grep a search that can reach a denied path is blocked", async (t) => {
	const base = makeTree(t);
	const harness = await setup(base, baseConfig({ deniedPaths: [`${base}/private/token.txt`] }), false);

	const result = await harness.call("grep", "t1", { pattern: "needle", path: "." });

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Search scope can contain a path denied by policy/);
});

test("find is still blocked when its scope can reach a denied path", async (t) => {
	const base = makeTree(t);
	const harness = await setup(base, baseConfig({ deniedPaths: [`${base}/private/token.txt`] }));

	const result = await harness.call("find", "t1", { query: "token", grep_keywords: [], path: "." });

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Search scope can contain a path denied by policy/);
});

test("a pattern that covers the whole search root cannot be narrowed and blocks", async (t) => {
	const base = makeTree(t);
	const harness = await setup(base, baseConfig({ deniedPaths: [`${base}/*`] }));

	const result = await harness.call("grep", "t1", { pattern: "needle", path: "." });

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Search scope can contain a path denied by policy/);
});

test("a grep whose scope cannot reach a denied path is not revised", async (t) => {
	const base = makeTree(t);
	const harness = await setup(base, baseConfig({ deniedPaths: ["/etc/*"] }));
	assert.equal(await harness.call("grep", "t1", { pattern: "needle", path: "." }), undefined);
});
