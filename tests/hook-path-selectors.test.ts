import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { baseConfig, createFakeCtx, setupHookTest } from "./test-helpers.ts";

test("deniedPaths blocks omp read selectors on denied files", async () => {
	const harness = await setupHookTest({
		config: baseConfig({
			deniedPaths: ["~/.netrc", "~/.config/gh/hosts.yml", "~/.ssh/*"],
		}),
	});

	for (const path of [
		"~/.netrc:1-2",
		"~/.config/gh/hosts.yml:raw",
		"~/.ssh/id_ed25519:1+5",
		"~/.ssh/id_ed25519:-5",
		"~/.netrc:2-4:raw",
		"~/.netrc:5-16,960-973",
		"~/.netrc:conflicts",
		"@~/.netrc:1-2",
		"~/.netrc?q=.password",
	]) {
		const result = await harness.emit("tool_call", {
			toolName: "read",
			input: { path },
		}, harness.ctx) as { block?: boolean; reason?: string };
		assert.equal(result?.block, true, path);
		assert.match(result?.reason ?? "", /Path denied by policy/, path);
	}
	assert.equal(harness.classifierCalls, 0);
});

test("deniedPaths blocks selector-bearing grep paths on denied files", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ deniedPaths: ["~/.netrc"] }),
	});

	const result = await harness.emit("tool_call", {
		toolName: "grep",
		input: { pattern: "password", path: "~/.netrc:1-20" },
	}, harness.ctx) as { block?: boolean; reason?: string };

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Path denied by policy/);
});

test("deniedPaths blocks delimited path lists that name a denied file", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ deniedPaths: ["~/.netrc"] }),
	});

	for (const [toolName, path] of [
		["read", "README.md;~/.netrc"],
		["read", "README.md,~/.netrc:1-2"],
		["read", "README.md ~/.netrc"],
		["grep", "src;~/.netrc"],
	] as const) {
		const result = await harness.emit("tool_call", {
			toolName,
			input: toolName === "grep" ? { pattern: "x", path } : { path },
		}, harness.ctx) as { block?: boolean; reason?: string };
		assert.equal(result?.block, true, `${toolName} ${path}`);
		assert.match(result?.reason ?? "", /Path denied by policy/, `${toolName} ${path}`);
	}
});

test("deniedPaths blocks container selectors on denied archives and databases", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ deniedPaths: ["/data/secrets.zip", "/data/vault.db"] }),
	});

	for (const path of ["/data/secrets.zip:keys/id_rsa", "/data/vault.db:logins:7"]) {
		const result = await harness.emit("tool_call", {
			toolName: "read",
			input: { path },
		}, harness.ctx) as { block?: boolean; reason?: string };
		assert.equal(result?.block, true, path);
		assert.match(result?.reason ?? "", /Path denied by policy/, path);
	}
});

test("deniedPaths does not block selectors on unrelated files", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ deniedPaths: ["~/.netrc"] }),
	});

	for (const path of ["README.md:1-5", "/tmp/project/src/app.ts:raw", "docs/a:b.md"]) {
		const result = await harness.emit("tool_call", {
			toolName: "read",
			input: { path },
		}, harness.ctx);
		assert.equal(result, undefined, path);
	}
});

test("deniedPaths still matches a real colon filename literally", async (t) => {
	const project = mkdtempSync(join(os.tmpdir(), "pi-automode-colon-"));
	t.after(() => rmSync(project, { recursive: true, force: true }));
	mkdirSync(join(project, "dir"));
	writeFileSync(join(project, "dir", "token:1-2"), "secret");
	const harness = await setupHookTest({
		config: baseConfig({ deniedPaths: [join(project, "dir", "token:1-2")] }),
		ctx: createFakeCtx([], { cwd: project }),
	});

	const result = await harness.emit("tool_call", {
		toolName: "read",
		input: { path: "dir/token:1-2" },
	}, harness.ctx) as { block?: boolean; reason?: string };

	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Path denied by policy/);
});

test("allowInsideWorkingDirectory allows selector-bearing reads of in-tree files", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ allowInsideWorkingDirectory: true, classifyReadOnlyTools: true }),
	});

	for (const path of ["src/app.ts:5-9", "src/app.ts:raw", "/tmp/project/a.md:1-2"]) {
		const result = await harness.emit("tool_call", {
			toolName: "read",
			input: { path },
		}, harness.ctx);
		assert.equal(result, undefined, path);
	}
	assert.equal(harness.classifierCalls, 0);
});

test("allowInsideWorkingDirectory sends selector paths that leave the tree to the classifier", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ allowInsideWorkingDirectory: true }),
	});

	for (const [toolName, path] of [
		["read", "/etc/hosts:1-2"],
		["read", "README.md;/etc/hosts"],
		["read", "src/a.ts ../outside.txt"],
		["grep", "src;/etc"],
	] as const) {
		const before = harness.classifierCalls;
		await harness.emit("tool_call", {
			toolName,
			input: toolName === "grep" ? { pattern: "x", path } : { path },
		}, harness.ctx);
		assert.equal(harness.classifierCalls, before + 1, `${toolName} ${path}`);
	}
});
