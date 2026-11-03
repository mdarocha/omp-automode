import test from "node:test";
import assert from "node:assert/strict";
import {
	gateUrlSchemePath,
	matchesToolPattern,
	parseToolPattern,
	urlSchemeOf,
} from "../extensions/auto-mode.ts";

const DEVICES = { deviceDispatch: true };
const NO_DEVICES = { deviceDispatch: false };

test("urlSchemeOf recognises OMP internal and web URLs", () => {
	assert.equal(urlSchemeOf("skill://github"), "skill");
	assert.equal(urlSchemeOf("xd://bash"), "xd");
	assert.equal(urlSchemeOf("ssh://host/etc/passwd"), "ssh");
	assert.equal(urlSchemeOf("HTTPS://example.com/a"), "https");
	assert.equal(urlSchemeOf("http://example.com/a"), "http");
	// OMP's read treats these as web pages too.
	assert.equal(urlSchemeOf("https:/example.com/a"), "https");
	assert.equal(urlSchemeOf("www.example.com/a"), "https");
	// Single-slash alias of the scratch root.
	assert.equal(urlSchemeOf("local:/notes.md"), "local");
});

test("urlSchemeOf leaves filesystem paths alone", () => {
	for (const path of [
		"src/app.ts",
		"/etc/hosts",
		"~/.netrc",
		"C://Users/me",
		"file:///tmp/a.txt",
		"dir/skill://x",
		"notes:1-2",
		"skill:/x",
	]) {
		assert.equal(urlSchemeOf(path), undefined, path);
	}
});

test("read-only tools allow built-in internal schemes and name the scheme", () => {
	for (const toolName of ["read", "grep", "find"]) {
		for (const url of [
			"skill://github",
			"local://notes.md",
			"artifact://3:1-20",
			"omp://",
			"history://abc",
			"issue://12",
			"pr://owner/repo/4",
			"agent://Main",
			"proc://7",
			"mcp://server/resource",
			"xd://github",
			"xd://github/ops",
		]) {
			const gate = gateUrlSchemePath(toolName, url, NO_DEVICES);
			assert.equal(gate?.decisions.length, 1, `${toolName} ${url}`);
			const decision = gate?.decisions[0];
			assert.equal(decision?.action, "allow", `${toolName} ${url}`);
			assert.match(
				decision?.action === "allow" ? decision.reason : "",
				new RegExp(`^Read-only ${url.split(":")[0]}:// resource`),
			);
			assert.deepEqual(gate?.pathEntries, []);
		}
	}
});

test("web, ssh, and unknown schemes go to the classifier for reads", () => {
	for (const url of [
		"https://example.com/a",
		"http://example.com/a",
		"https:/example.com/a",
		"www.example.com",
		"ssh://host/etc/passwd",
		"cfg://settings",
		"vault://notes",
		"notion://page/1",
	]) {
		const gate = gateUrlSchemePath("read", url, DEVICES);
		assert.equal(gate?.decisions[0]?.action, "classify", url);
	}
});

test("an at-sign before a URL does not hide the scheme", () => {
	assert.equal(gateUrlSchemePath("read", "@skill://github", DEVICES)?.decisions[0]?.scheme, "skill");
	assert.equal(gateUrlSchemePath("read", "@https://example.com", DEVICES)?.decisions[0]?.action, "classify");
});

test("read and grep judge each entry of a path list separately", () => {
	const mixed = gateUrlSchemePath("read", "README.md;https://example.com/x", DEVICES);
	assert.deepEqual(mixed?.pathEntries, ["README.md"]);
	assert.deepEqual(mixed?.decisions.map(({ action }) => action), ["classify"]);

	const allowed = gateUrlSchemePath("grep", "src skill://github", DEVICES);
	assert.deepEqual(allowed?.pathEntries, ["src"]);
	assert.deepEqual(allowed?.decisions.map(({ action }) => action), ["allow"]);

	assert.equal(gateUrlSchemePath("read", "README.md;src/a.ts", DEVICES), undefined);
});

test("write and edit never split a path into a list", () => {
	assert.equal(gateUrlSchemePath("write", "notes a.md", DEVICES), undefined);
	const gate = gateUrlSchemePath("write", "local://notes a.md", DEVICES);
	assert.equal(gate?.decisions.length, 1);
	assert.equal(gate?.decisions[0]?.action, "scratch");
});

test("local:// writes are session scratch", () => {
	for (const toolName of ["write", "edit"]) {
		for (const url of ["local://notes.md", "local:/notes.md"]) {
			const decision = gateUrlSchemePath(toolName, url, NO_DEVICES)?.decisions[0];
			assert.equal(decision?.action, "scratch", `${toolName} ${url}`);
			assert.match(decision?.action === "scratch" ? decision.reason : "", /^Session-local local:\/\/ scratch write/);
		}
	}
});

test("write to an xd:// device passes through only for OMP's built-in write", () => {
	const decision = gateUrlSchemePath("write", "xd://github", DEVICES)?.decisions[0];
	assert.equal(decision?.action, "device");
	assert.match(
		decision?.action === "device" ? decision.reason : "",
		/xd:\/\/ device dispatch: the nested github call is classified separately/,
	);
	assert.equal(gateUrlSchemePath("write", "xd://github", NO_DEVICES)?.decisions[0]?.action, "classify");
	assert.equal(gateUrlSchemePath("edit", "xd://github", DEVICES)?.decisions[0]?.action, "classify");
	for (const url of ["xd://", "xd://github/ops", "xd://github?x=1"]) {
		assert.equal(gateUrlSchemePath("write", url, DEVICES)?.decisions[0]?.action, "classify", url);
	}
});

test("other scheme writes go to the classifier", () => {
	for (const url of [
		"proc://7/kill",
		"proc://7",
		"agent://Main",
		"ssh://host/tmp/x",
		"skill://github/SKILL.md",
		"cfg://settings",
		"https://example.com/upload",
	]) {
		for (const toolName of ["write", "edit"]) {
			assert.equal(
				gateUrlSchemePath(toolName, url, DEVICES)?.decisions[0]?.action,
				"classify",
				`${toolName} ${url}`,
			);
		}
	}
});

test("plain paths produce no gate", () => {
	for (const toolName of ["read", "grep", "find", "write", "edit"]) {
		assert.equal(gateUrlSchemePath(toolName, "src/app.ts", DEVICES), undefined, toolName);
		assert.equal(gateUrlSchemePath(toolName, "", DEVICES), undefined, toolName);
	}
});

test("permission rules match scheme URLs as typed", () => {
	const cwd = "/tmp/project";
	const allow = parseToolPattern("read(https://docs.example.com/*)");
	assert.ok(allow);
	const allowed = (path: string) =>
		matchesToolPattern(allow, "read", { path }, cwd, "no-match");
	assert.equal(allowed("https://docs.example.com/guide"), true);
	assert.equal(allowed("https://docs.example.com.evil.test/guide"), false);
	assert.equal(allowed("https://evil.test/guide"), false);
	assert.equal(allowed("https://docs.example.com/a;https://evil.test/b"), false);

	const deny = parseToolPattern("read(https://evil.test/*)");
	assert.ok(deny);
	assert.equal(matchesToolPattern(deny, "read", { path: "https://evil.test/x" }, cwd, "match"), true);
	assert.equal(matchesToolPattern(deny, "read", { path: "README.md;https://evil.test/x" }, cwd, "match"), true);
	assert.equal(matchesToolPattern(deny, "read", { path: "README.md" }, cwd, "match"), false);

	const scratch = parseToolPattern("write(local://*)");
	assert.ok(scratch);
	assert.equal(matchesToolPattern(scratch, "write", { path: "local://notes.md" }, cwd, "no-match"), true);
});
