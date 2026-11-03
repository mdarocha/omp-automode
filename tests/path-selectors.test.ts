import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	inputPathVariants,
	matchesToolPattern,
	parseToolPattern,
	resolveInputPath,
	resolveToolInputPaths,
} from "../extensions/auto-mode.ts";
import { baseConfig, setupHookTest } from "./test-helpers.ts";

const HOME_NETRC = join(os.homedir(), ".netrc");

/** Every omp `read` selector spelling documented by the read tool. */
const READ_SELECTORS = [
	":5",
	":5-",
	":5-9",
	":5+3",
	":-5",
	":raw",
	":conflicts",
	":img",
	":2-4:raw",
	":raw:2-4",
	":17:raw",
	":17-:raw",
	":5-16,960-973",
	":19,59",
	":1-12,-15",
];

test("inputPathVariants keeps the literal path and adds every selector-free prefix", () => {
	for (const selector of READ_SELECTORS) {
		for (const toolName of ["read", "grep"]) {
			const variants = inputPathVariants(toolName, `~/.netrc${selector}`);
			assert.equal(variants[0], `~/.netrc${selector}`, `${toolName} ${selector}`);
			assert.ok(variants.includes("~/.netrc"), `${toolName} ${selector}`);
		}
	}
});

test("inputPathVariants strips query suffixes and container selectors", () => {
	assert.ok(
		inputPathVariants("read", "/data/hosts.json?q=.token&raw=true").includes("/data/hosts.json"),
	);
	assert.ok(inputPathVariants("read", "/data/app.db:users:42").includes("/data/app.db"));
	assert.ok(inputPathVariants("read", "/data/app.db:users:42").includes("/data/app.db:users"));
	assert.ok(inputPathVariants("read", "/data/bundle.zip:inner/key.pem").includes("/data/bundle.zip"));
});

test("inputPathVariants splits delimited path lists like omp read and grep", () => {
	for (const toolName of ["read", "grep"]) {
		for (const list of [
			"src/a.ts;~/.netrc",
			"src/a.ts,~/.netrc",
			"src/a.ts ~/.netrc",
			"src/a.ts\n~/.netrc",
			"src/a.ts;~/.netrc:1-2",
		]) {
			const variants = inputPathVariants(toolName, list);
			assert.equal(variants[0], list);
			assert.ok(variants.includes("src/a.ts"), `${toolName} ${JSON.stringify(list)}`);
			assert.ok(variants.includes("~/.netrc"), `${toolName} ${JSON.stringify(list)}`);
		}
	}
});

test("inputPathVariants leaves other tools and plain paths untouched", () => {
	assert.deepEqual(inputPathVariants("write", "notes:1-2;a b"), ["notes:1-2;a b"]);
	assert.deepEqual(inputPathVariants("edit", "a:raw"), ["a:raw"]);
	assert.deepEqual(inputPathVariants("find", "src/a.ts:1-5"), ["src/a.ts:1-5"]);
	assert.deepEqual(inputPathVariants("read", "src/app.ts"), ["src/app.ts"]);
});

test("resolveToolInputPaths resolves every variant against the working directory", () => {
	const cwd = "/tmp/project";
	assert.deepEqual(resolveToolInputPaths("read", cwd, "src/app.ts:5-9"), [
		"/tmp/project/src/app.ts:5-9",
		"/tmp/project/src/app.ts",
	]);
	assert.deepEqual(resolveToolInputPaths("read", cwd, "~/.netrc:1-2"), [
		`${HOME_NETRC}:1-2`,
		HOME_NETRC,
	]);
	assert.deepEqual(resolveToolInputPaths("write", cwd, "notes:1-2"), ["/tmp/project/notes:1-2"]);
	assert.deepEqual(resolveToolInputPaths("read", cwd, 42), []);
});

test("resolveInputPath keeps colons that are part of a real filename", () => {
	const cwd = "/tmp/project";
	assert.equal(resolveInputPath(cwd, "dir/a:b.txt"), "/tmp/project/dir/a:b.txt");
	assert.equal(resolveInputPath(cwd, "dir/notes:1-2"), "/tmp/project/dir/notes:1-2");
	assert.equal(resolveToolInputPaths("read", cwd, "dir/a:b.txt")[0], "/tmp/project/dir/a:b.txt");
});


test("permissions.deny read patterns match selector-bearing paths", async () => {
	const pattern = parseToolPattern("read(~/.netrc)");
	assert.ok(pattern);
	const cwd = "/tmp/project";
	for (const path of ["~/.netrc", "~/.netrc:1-2", "~/.netrc:raw", "~/.netrc?q=.a", "a;~/.netrc"]) {
		assert.equal(
			matchesToolPattern(pattern, "read", { path }, cwd, "match"),
			true,
			path,
		);
	}
	assert.equal(matchesToolPattern(pattern, "read", { path: "~/.netrc2:1-2" }, cwd, "match"), false);
	assert.equal(matchesToolPattern(pattern, "write", { path: "~/.netrc:1-2" }, cwd, "match"), false);

	const harness = await setupHookTest({
		config: baseConfig({ permissionDeny: [pattern] }),
	});
	const result = await harness.emit("tool_call", {
		toolName: "read",
		input: { path: "~/.netrc:1-2" },
	}, harness.ctx) as { block?: boolean; reason?: string };
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /permissions\.deny/);
});


test("resolveInputPath drops the stray leading colon omp tolerates", () => {
	const cwd = "/tmp/project";
	assert.equal(resolveInputPath(cwd, ":/etc/hosts"), "/etc/hosts");
	assert.equal(resolveInputPath(cwd, ":~/.netrc"), HOME_NETRC);
	assert.equal(resolveInputPath(cwd, ":./src/a.ts"), "/tmp/project/src/a.ts");
	assert.equal(resolveInputPath(cwd, ":notes.txt"), "/tmp/project/:notes.txt");
});

test("permissions.allow read patterns must cover every addressed path", () => {
	const pattern = parseToolPattern("read(/tmp/project/src/*)");
	assert.ok(pattern);
	const cwd = "/tmp/project";
	const covered = (path: string) =>
		matchesToolPattern(pattern, "read", { path }, cwd, "no-match");
	assert.equal(covered("src/a.ts"), true);
	assert.equal(covered("src/a.ts:5-9"), true);
	assert.equal(covered("src/a.ts;src/b.ts"), true);
	assert.equal(covered("src/a.ts;/etc/shadow"), false);
	assert.equal(covered("src/a.ts ~/.netrc"), false);
});

test("file URLs are converted the way OMP does before selectors are peeled", () => {
	const cwd = "/tmp/project";
	assert.equal(resolveInputPath(cwd, "FILE:///tmp/a.txt"), "/tmp/a.txt");
	assert.equal(resolveInputPath(cwd, "file://example.test/a.txt"), "/tmp/project/file:/example.test/a.txt");

	const variants = inputPathVariants("read", "file:///tmp/a.txt:1-5");
	assert.ok(variants.includes("/tmp/a.txt"));
	assert.ok(!variants.includes("file"));
	assert.deepEqual(resolveToolInputPaths("read", cwd, "file:///tmp/a.txt:1-5").slice(-1), ["/tmp/a.txt"]);
});

test("grep paths given as a JSON-encoded array are split into entries", () => {
	for (const toolName of ["read", "grep"]) {
		const variants = inputPathVariants(toolName, '["src/a.ts","~/.netrc:1-2","dir/my file.txt"]');
		assert.ok(variants.includes("src/a.ts"), toolName);
		assert.ok(variants.includes("~/.netrc"), toolName);
		assert.ok(variants.includes("dir/my file.txt"), toolName);
	}
	assert.ok(!inputPathVariants("grep", "[not json").includes("not json"));
});
