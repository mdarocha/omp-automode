import test from "node:test";
import assert from "node:assert/strict";
import {
	createPiAutomode,
	parseToolPattern,
	type ClassificationDecision,
	type EffectiveConfig,
} from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

const BUILTIN_WRITE = { path: "<builtin:write>", source: "builtin" };

async function setup(options: {
	config?: EffectiveConfig;
	builtinWrite?: boolean;
	decision?: ClassificationDecision;
	confirm?: boolean;
} = {}) {
	const fake = createFakePi();
	if (options.builtinWrite !== false) {
		fake.pi.getAllTools = () => [{ name: "write", sourceInfo: BUILTIN_WRITE }];
	}
	let classifierCalls = 0;
	createPiAutomode({
		loadConfig: () => options.config ?? baseConfig(),
		classifyAction: async () => {
			classifierCalls += 1;
			return options.decision ?? { decision: "allow", tier: "none", reason: "classifier allow" };
		},
	})(fake.pi);
	const ctx = createFakeCtx(fake.entries);
	ctx.ui.confirm = async () => options.confirm ?? true;
	await fake.emit("session_start", { type: "session_start" }, ctx);
	const call = (toolName: string, input: Record<string, unknown>) =>
		fake.emit("tool_call", { toolName, input }, ctx) as Promise<{ block?: boolean; reason?: string } | undefined>;
	return {
		call,
		get classifierCalls() { return classifierCalls; },
		get lastReason(): string { return fake.entries.at(-1)?.data.lastReason; },
	};
}

test("default config allows built-in scheme reads locally and sends web, ssh and mixed reads to the classifier", async () => {
	const harness = await setup({ decision: { decision: "block", tier: "soft_deny", reason: "no outbound reads" } });

	assert.equal(await harness.call("read", { path: "skill://github" }), undefined);
	assert.equal(harness.classifierCalls, 0);

	for (const [toolName, path] of [
		["read", "https://example.com/x"],
		["grep", "ssh://host/x"],
		["read", "README.md;https://example.com/x"],
	] as const) {
		const before = harness.classifierCalls;
		const result = await harness.call(toolName, toolName === "grep" ? { pattern: "x", path } : { path });
		assert.equal(result?.block, true, path);
		assert.equal(harness.classifierCalls, before + 1, path);
	}
});

test("classifyReadOnlyTools still allows built-in scheme reads locally and names the scheme", async () => {
	const harness = await setup({ config: baseConfig({ classifyReadOnlyTools: true }) });

	assert.equal(await harness.call("read", { path: "skill://github" }), undefined);
	assert.equal(harness.classifierCalls, 0);
	assert.match(harness.lastReason, /^Read-only skill:\/\/ resource/);
});

test("inside-working-directory tier does not treat scheme URLs as in-tree paths", async () => {
	const harness = await setup({ config: baseConfig({ allowInsideWorkingDirectory: true }) });

	for (const path of ["skill://github", "xd://propose", "local://notes.md", "artifact://3:1-20"]) {
		assert.equal(await harness.call("read", { path }), undefined, path);
		assert.match(harness.lastReason, /^Read-only \w+:\/\/ resource/, path);
		assert.doesNotMatch(harness.lastReason, /inside working directory/, path);
	}
	assert.equal(harness.classifierCalls, 0);

	await harness.call("read", { path: "https://example.com" });
	assert.equal(harness.classifierCalls, 1);

	assert.equal(await harness.call("read", { path: "README.md;skill://github" }), undefined);
	assert.equal(harness.classifierCalls, 1);
	await harness.call("read", { path: "/etc/hosts;skill://github" });
	assert.equal(harness.classifierCalls, 2);
});

test("deniedPaths is matched against scheme URLs as typed", async () => {
	const harness = await setup({ config: baseConfig({ deniedPaths: ["*.env"] }) });

	const result = await harness.call("read", { path: "skill://notes/.env" });
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Path denied by policy/);
	assert.equal(harness.classifierCalls, 0);
});

test("write to an xd:// device passes through only with OMP's built-in write", async () => {
	const withBuiltin = await setup();
	assert.equal(await withBuiltin.call("write", { path: "xd://github", content: "{}" }), undefined);
	assert.equal(withBuiltin.classifierCalls, 0);
	assert.match(withBuiltin.lastReason, /nested github call is classified separately/);

	const withoutBuiltin = await setup({ builtinWrite: false });
	await withoutBuiltin.call("write", { path: "xd://github", content: "{}" });
	assert.equal(withoutBuiltin.classifierCalls, 1);
});

test("local:// writes follow allowInsideWorkingDirectory", async () => {
	const off = await setup();
	await off.call("write", { path: "local://notes.md", content: "x" });
	assert.equal(off.classifierCalls, 1);

	const on = await setup({ config: baseConfig({ allowInsideWorkingDirectory: true }) });
	assert.equal(await on.call("write", { path: "local://notes.md", content: "x" }), undefined);
	assert.equal(on.classifierCalls, 0);
	assert.match(on.lastReason, /^Session-local local:\/\/ scratch write/);
});

test("proc, agent and ssh writes reach the classifier even with the in-tree tier on", async () => {
	const harness = await setup({ config: baseConfig({ allowInsideWorkingDirectory: true }) });

	for (const path of ["proc://7/kill", "agent://Main", "ssh://host/x"]) {
		const before = harness.classifierCalls;
		await harness.call("write", { path, content: "x" });
		assert.equal(harness.classifierCalls, before + 1, path);
	}
});

test("permissions.allow matches a URL as typed", async () => {
	const allow = parseToolPattern("read(https://docs.example.com/*)");
	assert.ok(allow);
	const harness = await setup({ config: baseConfig({ permissionAllow: [allow] }) });

	assert.equal(await harness.call("read", { path: "https://docs.example.com/a" }), undefined);
	assert.equal(harness.classifierCalls, 0);
	assert.equal(harness.lastReason, "Allowed by permissions.allow");

	await harness.call("read", { path: "https://evil.test/a" });
	assert.equal(harness.classifierCalls, 1);
});

test("an accepted permissions.ask rule keeps scheme reads on the classifier", async () => {
	const ask = parseToolPattern("read(*)");
	assert.ok(ask);
	const harness = await setup({ config: baseConfig({ permissionAsk: [ask] }) });

	await harness.call("read", { path: "skill://github" });
	assert.equal(harness.classifierCalls, 1);
});
