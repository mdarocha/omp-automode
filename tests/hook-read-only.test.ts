import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { parseToolPattern, type EffectiveConfig } from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, setupHookTest } from "./test-helpers.ts";

type Result = { block?: boolean; reason?: string } | undefined;

interface HookHarness {
	ctx: unknown;
	classifierCalls: number;
	emit(event: string, payload: unknown, ctx: unknown): Promise<unknown>;
}

const CLASSIFIER_BLOCK = {
	decision: "block" as const,
	tier: "soft_deny" as const,
	reason: "classifier consulted",
};

type Fixture = {
	base: string;
	project: string;
	root: string;
	outside: string;
	secrets: string;
};

function createFixture(t: { after: (callback: () => void) => void }): Fixture {
	const base = realpathSync(mkdtempSync(join(os.tmpdir(), "pi-automode-hook-ro-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const project = join(base, "project");
	const root = join(base, "scratch");
	const outside = join(base, "scratch-evil");
	const secrets = join(base, "secrets");
	for (const directory of [project, root, outside, secrets]) {
		mkdirSync(directory, { recursive: true });
	}
	mkdirSync(join(root, ".git"));
	mkdirSync(join(root, ".pi"));
	writeFileSync(join(root, "notes.txt"), "scratch\n");
	writeFileSync(join(root, ".git", "config"), "[core]\n");
	writeFileSync(join(root, ".pi", "automode.json"), "{}\n");
	writeFileSync(join(outside, "notes.txt"), "elsewhere\n");
	writeFileSync(join(secrets, "token.txt"), "s3cret\n");
	writeFileSync(join(project, "a.txt"), "alpha\n");
	symlinkSync(secrets, join(root, "to-secrets"));
	symlinkSync(join(secrets, "token.txt"), join(root, "token-link"));
	return { base, project, root, outside, secrets };
}

async function harnessFor(
	fixture: Fixture,
	overrides: Partial<EffectiveConfig> = {},
) {
	return await setupHookTest({
		config: baseConfig({
			allowInsideWorkingDirectory: true,
			readOnlyRoots: [fixture.root],
			...overrides,
		}),
		ctx: createFakeCtx([], { cwd: fixture.project }),
		classifier: async () => CLASSIFIER_BLOCK,
	});
}

async function call(
	harness: HookHarness,
	toolName: string,
	input: Record<string, unknown>,
): Promise<Result> {
	return await harness.emit("tool_call", { toolName, input }, harness.ctx) as Result;
}

test("readOnlyRoots lets read-only file tools outside the working directory skip the classifier", async (t) => {
	const fixture = createFixture(t);
	const harness = await harnessFor(fixture);

	assert.equal(await call(harness, "read", { path: join(fixture.root, "notes.txt") }), undefined);
	assert.equal(await call(harness, "grep", { pattern: "scratch", path: fixture.root }), undefined);
	assert.equal(await call(harness, "find", { pattern: "*.txt", path: fixture.root }), undefined);
	assert.equal(await call(harness, "ls", { path: fixture.root }), undefined);
	assert.equal(harness.classifierCalls, 0);
});

test("without readOnlyRoots the same reads outside the working directory reach the classifier", async (t) => {
	const fixture = createFixture(t);
	const harness = await harnessFor(fixture, { readOnlyRoots: [] });

	const result = await call(harness, "read", { path: join(fixture.root, "notes.txt") });

	assert.equal(result?.block, true);
	assert.equal(harness.classifierCalls, 1);
});

test("readOnlyRoots also applies when read-only tools are classified", async (t) => {
	const fixture = createFixture(t);
	const harness = await harnessFor(fixture, {
		allowInsideWorkingDirectory: false,
		classifyReadOnlyTools: true,
	});

	assert.equal(await call(harness, "read", { path: join(fixture.root, "notes.txt") }), undefined);
	assert.equal(harness.classifierCalls, 0);
	const outside = await call(harness, "read", { path: join(fixture.outside, "notes.txt") });
	assert.equal(outside?.block, true);
	assert.equal(harness.classifierCalls, 1);
});

test("readOnlyRoots never covers write or edit", async (t) => {
	const fixture = createFixture(t);
	for (const toolName of ["write", "edit"]) {
		const harness = await harnessFor(fixture);
		const result = await call(harness, toolName, { path: join(fixture.root, "notes.txt") });
		assert.equal(result?.block, true, toolName);
		assert.equal(harness.classifierCalls, 1, toolName);
	}
});

test("paths outside every root still reach the classifier", async (t) => {
	const fixture = createFixture(t);
	const attempts: Array<[string, Record<string, unknown>, string]> = [
		["read", { path: join(fixture.outside, "notes.txt") }, "sibling that shares the root name as a prefix"],
		["read", { path: `${fixture.root}-notes` }, "prefix confusion without a separator"],
		["read", { path: join(fixture.root, "..", "scratch-evil", "notes.txt") }, "dot-dot out of the root"],
		["read", { path: join(fixture.root, "to-secrets", "token.txt") }, "symlinked directory leaving the root"],
		["read", { path: join(fixture.root, "token-link") }, "symlinked file leaving the root"],
		["ls", { path: join(fixture.root, "to-secrets") }, "ls through a symlink leaving the root"],
		["grep", { pattern: "x", path: join(fixture.root, "to-secrets") }, "grep through a symlink leaving the root"],
		["read", { path: fixture.base }, "parent of the root"],
		["read", { path: join(fixture.root.toUpperCase(), "notes.txt") }, "case-folded spelling of the root"],
	];
	for (const [toolName, input, label] of attempts) {
		const harness = await harnessFor(fixture);
		const result = await call(harness, toolName, input);
		assert.equal(result?.block, true, label);
		assert.equal(harness.classifierCalls, 1, label);
	}
});

test("deniedPaths still blocks inside a read-only root", async (t) => {
	const fixture = createFixture(t);
	const harness = await harnessFor(fixture, {
		deniedPaths: [join(fixture.root, "secret*"), `${fixture.secrets}/*`],
	});
	writeFileSync(join(fixture.root, "secret.txt"), "x");

	const direct = await call(harness, "read", { path: join(fixture.root, "secret.txt") });
	assert.equal(direct?.block, true);
	assert.match(direct?.reason ?? "", /Path denied by policy/);

	const viaSymlink = await call(harness, "read", { path: join(fixture.root, "token-link") });
	assert.equal(viaSymlink?.block, true);
	assert.match(viaSymlink?.reason ?? "", /Path denied by policy/);
	assert.equal(harness.classifierCalls, 0);
});

test("protected and safety-control paths inside a read-only root still reach the classifier", async (t) => {
	const fixture = createFixture(t);
	for (const path of [join(fixture.root, ".git", "config"), join(fixture.root, ".pi", "automode.json")]) {
		const harness = await harnessFor(fixture);
		const result = await call(harness, "read", { path });
		assert.equal(result?.block, true, path);
		assert.equal(harness.classifierCalls, 1, path);
	}
});

test("an accepted permissions.ask rule still sends a read-only-root path to the classifier", async (t) => {
	const fixture = createFixture(t);
	const ask = parseToolPattern("read");
	assert.ok(ask);
	const ctx = createFakeCtx([], { cwd: fixture.project });
	ctx.ui.confirm = async () => true;
	const harness = await setupHookTest({
		config: baseConfig({
			allowInsideWorkingDirectory: true,
			readOnlyRoots: [fixture.root],
			permissionAsk: [ask],
		}),
		ctx,
		classifier: async () => CLASSIFIER_BLOCK,
	});

	const result = await call(harness, "read", { path: join(fixture.root, "notes.txt") });

	assert.equal(result?.block, true);
	assert.equal(harness.classifierCalls, 1);
});

test("a permissions.deny rule still blocks a read inside a read-only root", async (t) => {
	const fixture = createFixture(t);
	const deny = parseToolPattern("read");
	assert.ok(deny);
	const harness = await harnessFor(fixture, { permissionDeny: [deny] });

	const result = await call(harness, "read", { path: join(fixture.root, "notes.txt") });

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /permissions\.deny/);
	assert.equal(harness.classifierCalls, 0);
});

async function bashHarness(
	fixture: Fixture,
	overrides: Partial<EffectiveConfig> = {},
) {
	return await setupHookTest({
		config: baseConfig({ allowReadOnlyBash: true, ...overrides }),
		ctx: createFakeCtx([], { cwd: fixture.project }),
		classifier: async () => CLASSIFIER_BLOCK,
	});
}

test("allowReadOnlyBash is off by default", async (t) => {
	const fixture = createFixture(t);
	const harness = await bashHarness(fixture, { allowReadOnlyBash: false });

	const result = await call(harness, "bash", { command: "cat a.txt" });

	assert.equal(result?.block, true);
	assert.equal(harness.classifierCalls, 1);
});

test("allowReadOnlyBash lets provably read-only commands skip the classifier", async (t) => {
	const fixture = createFixture(t);
	const harness = await bashHarness(fixture);

	for (const command of [
		"cat a.txt",
		"ls -la | head -n 5",
		"git status --short",
		`cd ${fixture.project} && cat a.txt | wc -l`,
		"grep -rn alpha . 2>/dev/null | head",
		`cat ${join(fixture.root, "notes.txt")}`,
	]) {
		assert.equal(await call(harness, "bash", { command }), undefined, command);
	}
	assert.equal(harness.classifierCalls, 0);
});

test("allowReadOnlyBash sends everything it cannot prove read-only to the classifier", async (t) => {
	const fixture = createFixture(t);
	const commands = [
		"cat a.txt > out.txt",
		"cat a.txt >> out.txt",
		"echo hi | tee out.txt",
		"sed -n 'w out.txt' a.txt",
		"git -c core.pager=sh log",
		"find . -exec cat {} +",
		"rg --pre cat alpha .",
		"cat $(echo a.txt)",
		"A=1 cat a.txt",
		"cat a.txt; rm a.txt",
		"cat a.txt && rm a.txt",
		"cat a.txt | xargs rm",
		"less a.txt",
		"cat *",
	];
	for (const command of commands) {
		const harness = await bashHarness(fixture);
		const result = await call(harness, "bash", { command });
		assert.equal(result?.block, true, command);
		assert.equal(harness.classifierCalls, 1, command);
	}
});

test("allowReadOnlyBash applies deniedPaths to every path argument", async (t) => {
	const fixture = createFixture(t);
	const deniedPaths = [`${fixture.secrets}/*`, fixture.secrets];
	for (const command of [
		`cat ${join(fixture.secrets, "token.txt")}`,
		`cat ${join(fixture.root, "token-link")}`,
		`cat ${join(fixture.root, "to-secrets", "token.txt")}`,
		`ls ${fixture.secrets}`,
		`grep -r s3cret ${fixture.base}`,
	]) {
		const harness = await bashHarness(fixture, { deniedPaths });
		const result = await call(harness, "bash", { command });
		assert.equal(result?.block, true, command);
		assert.equal(harness.classifierCalls, 1, command);
	}
});

test("permissions.deny and permissions.ask run before the read-only bash tier", async (t) => {
	const fixture = createFixture(t);
	const deny = parseToolPattern("bash(git log*)");
	const ask = parseToolPattern("bash(cat *)");
	assert.ok(deny);
	assert.ok(ask);

	const denied = await bashHarness(fixture, { permissionDeny: [deny] });
	const deniedResult = await call(denied, "bash", { command: "git log" });
	assert.equal(deniedResult?.block, true);
	assert.match(deniedResult?.reason ?? "", /permissions\.deny/);
	assert.equal(denied.classifierCalls, 0);

	const ctx = createFakeCtx([], { cwd: fixture.project });
	ctx.ui.confirm = async () => true;
	const asked = await setupHookTest({
		config: baseConfig({ allowReadOnlyBash: true, permissionAsk: [ask] }),
		ctx,
		classifier: async () => CLASSIFIER_BLOCK,
	});
	const askedResult = await call(asked, "bash", { command: "cat a.txt" });
	assert.equal(askedResult?.block, true);
	assert.equal(asked.classifierCalls, 1);
});

test("hard-deny still blocks a profile write that follows a read-only command", async (t) => {
	const fixture = createFixture(t);
	const harness = await bashHarness(fixture);

	const result = await call(harness, "bash", {
		command: "cat a.txt >> ~/.zshrc",
	});

	assert.equal(result?.block, true);
	assert.equal(harness.classifierCalls, 0);
	assert.match(result?.reason ?? "", /hard-denied/);
});

test("allowReadOnlyBash does not affect non-bash tools", async (t) => {
	const fixture = createFixture(t);
	const harness = await bashHarness(fixture);

	const result = await call(harness, "write", { path: join(fixture.project, "a.txt"), content: "x" });

	assert.equal(result?.block, true);
	assert.equal(harness.classifierCalls, 1);
});

test("the bash tool's cwd argument moves the analyzed directory", async (t) => {
	const fixture = createFixture(t);
	const deniedPaths = [`${fixture.secrets}/*`, fixture.secrets];

	const benign = await bashHarness(fixture, { deniedPaths });
	assert.equal(await call(benign, "bash", { command: "cat notes.txt", cwd: fixture.root }), undefined);
	assert.equal(benign.classifierCalls, 0);

	for (const cwd of [fixture.secrets, join(fixture.root, "to-secrets"), "../secrets"]) {
		const harness = await bashHarness(fixture, { deniedPaths });
		const result = await call(harness, "bash", { command: "cat token.txt", cwd });
		assert.equal(result?.block, true, cwd);
		assert.equal(harness.classifierCalls, 1, cwd);
	}
});

test("an unusable bash cwd argument sends the command to the classifier", async (t) => {
	const fixture = createFixture(t);
	for (const cwd of [42, ["/tmp"], { path: "/tmp" }, "skill://git", "ssh://host/tmp", "/tmp;/etc", "/tm*"]) {
		const harness = await bashHarness(fixture);
		const result = await call(harness, "bash", { command: "cat a.txt", cwd });
		assert.equal(result?.block, true, JSON.stringify(cwd));
		assert.equal(harness.classifierCalls, 1, JSON.stringify(cwd));
	}
	const empty = await bashHarness(fixture);
	assert.equal(await call(empty, "bash", { command: "cat a.txt", cwd: "" }), undefined);
});

test("with allowInsideWorkingDirectory, read-only bash stays inside the working directory or a read-only root", async (t) => {
	const fixture = createFixture(t);
	const harness = await bashHarness(fixture, {
		allowInsideWorkingDirectory: true,
		readOnlyRoots: [fixture.root],
	});

	assert.equal(await call(harness, "bash", { command: "cat a.txt | head -n 1" }), undefined);
	assert.equal(await call(harness, "bash", { command: `cat ${join(fixture.root, "notes.txt")}` }), undefined);
	assert.equal(harness.classifierCalls, 0);

	for (const command of [
		`cat ${join(fixture.outside, "notes.txt")}`,
		`ls ${fixture.base}`,
		"cat /etc/hostname",
		`cat ${join(fixture.root, "token-link")}`,
		`cd ${fixture.outside} && cat notes.txt`,
	]) {
		const other = await bashHarness(fixture, {
			allowInsideWorkingDirectory: true,
			readOnlyRoots: [fixture.root],
		});
		const result = await call(other, "bash", { command });
		assert.equal(result?.block, true, command);
		assert.equal(other.classifierCalls, 1, command);
	}
});

test("without allowInsideWorkingDirectory read-only bash may read outside the working directory", async (t) => {
	const fixture = createFixture(t);
	const harness = await bashHarness(fixture);

	assert.equal(await call(harness, "bash", { command: `cat ${join(fixture.outside, "notes.txt")}` }), undefined);
	assert.equal(harness.classifierCalls, 0);
});

test("a file-tool path that lists several targets or uses a URL never takes the read-only-root tier", async (t) => {
	const fixture = createFixture(t);
	for (const path of [
		`${join(fixture.root, "notes.txt")};${fixture.secrets}`,
		`${fixture.root}/*`,
		`${fixture.root}/{a,b}`,
		`file://${join(fixture.root, "notes.txt")}`,
	]) {
		const harness = await harnessFor(fixture);
		const result = await call(harness, "grep", { pattern: "x", path });
		assert.equal(result?.block, true, path);
		assert.equal(harness.classifierCalls, 1, path);
	}
});
