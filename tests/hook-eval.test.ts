import assert from "node:assert/strict";
import test from "node:test";
import {
	analyzeBash,
	isMalformedToolPattern,
	matchesToolPattern,
	parseToolPattern,
	type ToolPattern,
} from "../extensions/auto-mode.ts";
import { matchesAllowedEvalPatterns, prepareEvalChecks } from "../extensions/auto-mode/eval-checks.ts";
import { baseConfig, createFakeCtx, setupHookTest } from "./test-helpers.ts";

type HookResult = { block?: boolean; reason?: string } | undefined;

function patterns(...raw: string[]): ToolPattern[] {
	return raw.map((entry) => {
		const pattern = parseToolPattern(entry);
		assert.ok(pattern, entry);
		return pattern;
	});
}

function evalCall(code: string, language: string | undefined = "py") {
	return { toolName: "eval", input: language === undefined ? { code } : { language, code } };
}

const SUBPROCESS_RM = "import subprocess\nsubprocess.run(['rm', '-rf', '/*'])";

test("eval(...) permission patterns parse and diagnose like other tools", () => {
	const parsed = parseToolPattern("eval(py: subprocess*)");
	assert.ok(parsed);
	assert.equal(parsed.toolName, "eval");
	assert.equal(parsed.argumentPattern, "py: subprocess*");
	assert.equal(isMalformedToolPattern(parsed), false);
	assert.equal(isMalformedToolPattern(parseToolPattern("eval")!), false);
	assert.equal(isMalformedToolPattern(parseToolPattern("eval(*rm*)")!), false);
	assert.equal(isMalformedToolPattern(parseToolPattern("eval()")!), true);
	assert.equal(isMalformedToolPattern(parseToolPattern("eval(   )")!), true);
	assert.equal(isMalformedToolPattern(parseToolPattern("eval(py:)")!), true);
	assert.equal(isMalformedToolPattern(parseToolPattern("eval(js:   )")!), true);
	assert.equal(parseToolPattern("Eval(*x*)")?.toolName, "eval");
});

test("eval patterns match the code text with wildcard semantics", () => {
	const input = { language: "py", code: "import os\nos.system('rm -rf /')\n" };
	const match = (raw: string, policy: "match" | "no-match" = "match") =>
		matchesToolPattern(parseToolPattern(raw)!, "eval", input, "/tmp", policy);
	assert.equal(match("eval"), true);
	assert.equal(match("eval(*rm -rf*)"), true);
	assert.equal(match("eval(*RM -RF*)"), true);
	assert.equal(match("eval(import os*)"), true);
	assert.equal(match("eval(rm*)"), false);
	assert.equal(match("eval(*git push*)"), false);
	assert.equal(match("eval(*os.system*)"), true);
	assert.equal(match("bash(*rm -rf*)"), false);
});

test("eval language scope narrows a pattern; unknown language fails closed for deny only", () => {
	const python = { language: "py", code: "x" };
	const javascript = { language: "js", code: "x" };
	const unknown = { code: "x" };
	const scoped = parseToolPattern("eval(py: x)")!;
	assert.equal(matchesToolPattern(scoped, "eval", python, "/tmp"), true);
	assert.equal(matchesToolPattern(scoped, "eval", javascript, "/tmp"), false);
	assert.equal(matchesToolPattern(scoped, "eval", { language: "python", code: "x" }, "/tmp"), true);
	assert.equal(matchesToolPattern(scoped, "eval", unknown, "/tmp", "match"), true);
	assert.equal(matchesToolPattern(scoped, "eval", unknown, "/tmp", "no-match"), false);
	const jsScoped = parseToolPattern("eval(js:*)")!;
	assert.equal(matchesToolPattern(jsScoped, "eval", javascript, "/tmp"), true);
	assert.equal(matchesToolPattern(jsScoped, "eval", python, "/tmp"), false);
	// A pattern that merely starts with a language name but is not scoped.
	const literal = parseToolPattern("eval(*py: x*)")!;
	assert.equal(matchesToolPattern(literal, "eval", { language: "js", code: "py: x" }, "/tmp"), true);
});

test("eval patterns fail closed on inputs without code", () => {
	const pattern = parseToolPattern("eval(*safe*)")!;
	assert.equal(matchesToolPattern(pattern, "eval", {}, "/tmp", "match"), true);
	assert.equal(matchesToolPattern(pattern, "eval", {}, "/tmp", "no-match"), false);
	assert.equal(matchesToolPattern(pattern, "eval", { code: 5 }, "/tmp", "match"), true);
});

test("deny bash(rm -rf /*) blocks eval that runs the command through subprocess", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ permissionDeny: patterns("bash(rm -rf /*)") }),
	});
	const result = await harness.emit("tool_call", evalCall(SUBPROCESS_RM), harness.ctx) as HookResult;
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /permissions\.deny: bash\(rm -rf \/\*\)/);
	assert.match(result?.reason ?? "", /embedded in eval/);
	assert.equal(harness.classifierCalls, 0);
});

test("bash deny rules also catch Python strings, os.system, JS child_process and Bun templates", async () => {
	const cases: Array<[string, string, string]> = [
		["py", "import os\nos.system('git push --force origin main')", "bash(git push --force*)"],
		["py", "import subprocess\nsubprocess.run('git push --force origin main', shell=True)", "bash(git push --force*)"],
		["py", "!git push --force origin main", "bash(git push --force*)"],
		["js", "const { execSync } = require('child_process');\nexecSync('git push --force origin main')", "bash(git push --force*)"],
		["js", "import { spawnSync } from 'node:child_process';\nspawnSync('git', ['push', '--force'])", "bash(git push --force*)"],
		["js", "await Bun.$`git push --force origin main`", "bash(git push --force*)"],
		["js", "Bun.spawn(['git', 'push', '--force'])", "bash(git push --force*)"],
	];
	for (const [language, code, rule] of cases) {
		const harness = await setupHookTest({ config: baseConfig({ permissionDeny: patterns(rule) }) });
		const result = await harness.emit("tool_call", evalCall(code, language), harness.ctx) as HookResult;
		assert.equal(result?.block, true, code);
		assert.match(result?.reason ?? "", /permissions\.deny/, code);
		assert.equal(harness.classifierCalls, 0, code);
	}
});

test("a bash deny rule does not block an eval with unrelated commands", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ permissionDeny: patterns("bash(git push --force*)") }),
	});
	const result = await harness.emit(
		"tool_call",
		evalCall("import subprocess\nsubprocess.run(['git', 'status'])"),
		harness.ctx,
	) as HookResult;
	assert.equal(result, undefined);
	assert.equal(harness.classifierCalls, 1);
});

test("a command in any position of a multi-command eval is checked", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ permissionDeny: patterns("bash(gh pr create*)") }),
	});
	const code = [
		"import subprocess, os",
		"subprocess.run(['git', 'status'])",
		"os.system('echo hi')",
		"subprocess.run(['gh', 'pr', 'create', '--fill'])",
	].join("\n");
	const result = await harness.emit("tool_call", evalCall(code), harness.ctx) as HookResult;
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /gh pr create/);
});

test("eval(...) deny patterns fire on the code text", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ permissionDeny: patterns("eval(*shutil.rmtree*)") }),
	});
	const result = await harness.emit(
		"tool_call",
		evalCall("import shutil\nshutil.rmtree('/tmp/x')"),
		harness.ctx,
	) as HookResult;
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /permissions\.deny: eval\(\*shutil\.rmtree\*\)/);
	assert.equal(harness.classifierCalls, 0);
});

test("language-scoped eval deny only fires for that language", async () => {
	const config = baseConfig({ permissionDeny: patterns("eval(py: *requests.post*)") });
	const blocked = await setupHookTest({ config });
	const python = await blocked.emit(
		"tool_call",
		evalCall("requests.post('https://x', data=d)", "py"),
		blocked.ctx,
	) as HookResult;
	assert.equal(python?.block, true);

	const allowed = await setupHookTest({ config });
	const javascript = await allowed.emit(
		"tool_call",
		evalCall("requests.post('https://x', data=d)", "js"),
		allowed.ctx,
	) as HookResult;
	assert.equal(javascript, undefined);

	const unknown = await setupHookTest({ config });
	const noLanguage = await unknown.emit(
		"tool_call",
		evalCall("requests.post('https://x', data=d)", undefined),
		unknown.ctx,
	) as HookResult;
	assert.equal(noLanguage?.block, true, "an unknown language cannot be proven out of scope");
});

test("a malformed eval deny pattern fails closed", async () => {
	const harness = await setupHookTest({ config: baseConfig({ permissionDeny: patterns("eval(py:)") }) });
	const result = await harness.emit("tool_call", evalCall("print(1)"), harness.ctx) as HookResult;
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /permissions\.deny/);
});

test("eval ask patterns block without UI and honour a declined confirmation", async () => {
	const config = baseConfig({ permissionAsk: patterns("eval(*gh pr create*)") });
	const code = "import os\nos.system('gh pr create')";

	const headless = await setupHookTest({ config, ctx: createFakeCtx([], { hasUI: false }) });
	const noUi = await headless.emit("tool_call", evalCall(code), headless.ctx) as HookResult;
	assert.equal(noUi?.block, true);
	assert.match(noUi?.reason ?? "", /permissions\.ask.*no UI is available/);

	const ctx = createFakeCtx();
	ctx.ui.confirm = async () => false;
	const declined = await setupHookTest({ config, ctx });
	const result = await declined.emit("tool_call", evalCall(code), declined.ctx) as HookResult;
	assert.equal(result?.block, true);
	assert.match(result?.reason ?? "", /Declined permissions\.ask/);
	assert.equal(declined.classifierCalls, 0);
});

test("bash ask patterns apply to commands embedded in eval and force the classifier", async () => {
	const config = baseConfig({
		permissionAsk: patterns("bash(gh pr create*)"),
		permissionAllow: patterns("eval"),
	});
	const harness = await setupHookTest({ config });
	const result = await harness.emit(
		"tool_call",
		evalCall("import os\nos.system('gh pr create --fill')"),
		harness.ctx,
	) as HookResult;
	assert.equal(result, undefined);
	assert.equal(harness.classifierCalls, 1, "an accepted ask rule skips the allow tier");

	const headless = await setupHookTest({ config, ctx: createFakeCtx([], { hasUI: false }) });
	const blocked = await headless.emit(
		"tool_call",
		evalCall("import os\nos.system('gh pr create --fill')"),
		headless.ctx,
	) as HookResult;
	assert.equal(blocked?.block, true);
	assert.match(blocked?.reason ?? "", /permissions\.ask.*gh pr create/);
});

test("hard-deny catches destructive commands embedded in eval", async () => {
	const cases: Array<[string, string]> = [
		["py", "import os\nos.system('rm -rf ~')"],
		["py", "import subprocess\nsubprocess.run(['rm', '-rf', '/'])"],
		["py", "import subprocess\nsubprocess.run(['rm', '-rf', '~'])"],
		["py", "import subprocess\nsubprocess.run('rm -rf ~/', shell=True)"],
		["py", "!rm -rf /"],
		["py", "%%bash\nrm -rf ~\n"],
		["js", "execSync('rm -rf ~')"],
		["js", "await Bun.$`rm -rf /`"],
		["js", "Bun.spawn(['rm', '-rf', '/'])"],
		["py", "import subprocess\nsubprocess.run(['cat', '/etc/shadow'], cwd='/')\nsubprocess.run(['rm', '-rf', '.'], cwd='/')"],
	];
	for (const [language, code] of cases) {
		const harness = await setupHookTest();
		const result = await harness.emit("tool_call", evalCall(code, language), harness.ctx) as HookResult;
		assert.equal(result?.block, true, code);
		assert.match(result?.reason ?? "", /Embedded in eval/, code);
		assert.equal(harness.classifierCalls, 0, code);
	}
});

test("hard-deny blocks an embedded command even when permissions.allow covers the eval", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ permissionAllow: patterns("eval", "bash") }),
	});
	const result = await harness.emit(
		"tool_call",
		evalCall("import os\nos.system('rm -rf ~')"),
		harness.ctx,
	) as HookResult;
	assert.equal(result?.block, true);
	assert.equal(harness.classifierCalls, 0);
});

test("dynamic shell strings make the eval opaque: the classifier always runs and skips the fast stage", async () => {
	const dynamic = [
		"import subprocess\nsubprocess.run(f'rm -rf {path}', shell=True)",
		"import subprocess\ncmd = 'rm -rf /tmp/x'\nsubprocess.run(cmd, shell=True)",
		"import subprocess\nsubprocess.run('rm -rf ' + target, shell=True)",
		"import subprocess\ngetattr(subprocess, 'run')(['ls'])",
		"__import__('os').system('ls')",
		"import os as o\no.system('ls')",
		"exec(code)",
		"import ctypes",
	];
	for (const code of dynamic) {
		const harness = await setupHookTest({ config: baseConfig({ permissionAllow: patterns("eval") }) });
		const result = await harness.emit("tool_call", evalCall(code), harness.ctx) as HookResult;
		assert.equal(result, undefined, code);
		assert.equal(harness.classifierCalls, 1, `${code}: opaque eval must not be allowed by a broad eval allow rule`);
		assert.equal(harness.classifierHints[0]?.skipFastStage, true, code);
		const notes = (harness.classifierHints[0]?.notes ?? []).join("\n");
		assert.match(notes, /opaque/, code);
	}
});

test("a literal eval reaches the classifier with notes but may use the fast stage", async () => {
	const harness = await setupHookTest();
	await harness.emit(
		"tool_call",
		evalCall("import subprocess\nsubprocess.run(['git', 'status'])"),
		harness.ctx,
	);
	assert.equal(harness.classifierCalls, 1);
	assert.notEqual(harness.classifierHints[0]?.skipFastStage, true);
	const notes = (harness.classifierHints[0]?.notes ?? []).join("\n");
	assert.match(notes, /subprocess\.run: "git status"/);
	assert.doesNotMatch(notes, /opaque/);
});

test("non-eval tools never get eval hints", async () => {
	const harness = await setupHookTest();
	await harness.emit("tool_call", { toolName: "bash", input: { command: "ls" } }, harness.ctx);
	assert.equal(harness.classifierCalls, 1);
	assert.equal(harness.classifierHints[0], undefined);
});

test("eval allow rules: literal eval without commands is allowed, opaque eval is not", async () => {
	const config = baseConfig({ permissionAllow: patterns("eval(py: print*)") });
	const harness = await setupHookTest({ config });
	const allowed = await harness.emit("tool_call", evalCall("print(1 + 1)"), harness.ctx) as HookResult;
	assert.equal(allowed, undefined);
	assert.equal(harness.classifierCalls, 0);

	const wrongLanguage = await setupHookTest({ config });
	await wrongLanguage.emit("tool_call", evalCall("print(1 + 1)", "js"), wrongLanguage.ctx);
	assert.equal(wrongLanguage.classifierCalls, 1);

	const opaque = await setupHookTest({ config });
	await opaque.emit("tool_call", evalCall("print(eval(x))"), opaque.ctx);
	assert.equal(opaque.classifierCalls, 1);
});

test("an eval allow rule needs bash allow rules for every embedded command", async () => {
	const code = "import subprocess\nsubprocess.run(['git', 'status', '--short'])";

	const evalOnly = await setupHookTest({ config: baseConfig({ permissionAllow: patterns("eval") }) });
	await evalOnly.emit("tool_call", evalCall(code), evalOnly.ctx);
	assert.equal(evalOnly.classifierCalls, 1, "eval rule alone must not allow an embedded command");

	const bashOnly = await setupHookTest({ config: baseConfig({ permissionAllow: patterns("bash(git status*)") }) });
	await bashOnly.emit("tool_call", evalCall(code), bashOnly.ctx);
	assert.equal(bashOnly.classifierCalls, 1, "bash rules alone must not allow eval");

	const both = await setupHookTest({
		config: baseConfig({ permissionAllow: patterns("eval", "bash(git status*)") }),
	});
	const result = await both.emit("tool_call", evalCall(code), both.ctx) as HookResult;
	assert.equal(result, undefined);
	assert.equal(both.classifierCalls, 0);

	const outside = await setupHookTest({
		config: baseConfig({ permissionAllow: patterns("eval", "bash(git status*)") }),
	});
	await outside.emit(
		"tool_call",
		evalCall("import subprocess\nsubprocess.run(['git', 'push'])"),
		outside.ctx,
	);
	assert.equal(outside.classifierCalls, 1);
});

test("matchesAllowedEvalPatterns is false for opaque evals regardless of rules", () => {
	const rules = patterns("eval");
	const check = (code: string, allow: ToolPattern[]) => {
		const input = { language: "py", code };
		return matchesAllowedEvalPatterns(allow, input, "/tmp", prepareEvalChecks(input, analyzeBash));
	};
	assert.equal(check("x = 1", rules), true);
	assert.equal(check("exec(x)", rules), false);
	assert.equal(check("x = 1", patterns("bash")), false);
	const withCommand = "import os\nos.system('git status')";
	assert.equal(check(withCommand, rules), false);
	assert.equal(check(withCommand, patterns("eval", "bash(git status)")), true);
});

test("tool.bash calls inside eval code are left to the tool_call hook, not re-parsed", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ permissionDeny: patterns("bash(rm -rf*)") }),
	});
	const result = await harness.emit(
		"tool_call",
		evalCall("tool.bash(command='rm -rf /tmp/x')"),
		harness.ctx,
	) as HookResult;
	assert.equal(result, undefined);
	const nested = await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "rm -rf /tmp/x" },
		parentToolCallId: "eval-1",
	}, harness.ctx) as HookResult;
	assert.equal(nested?.block, true);
});

test("an embedded string that is not valid shell is reported opaque instead of blocking", async () => {
	const harness = await setupHookTest({ config: baseConfig({ permissionDeny: patterns("bash(rm -rf*)") }) });
	const result = await harness.emit(
		"tool_call",
		evalCall("import os\nos.system(\"echo 'unterminated\")"),
		harness.ctx,
	) as HookResult;
	assert.equal(result, undefined);
	assert.equal(harness.classifierCalls, 1);
	assert.equal(harness.classifierHints[0]?.skipFastStage, true);
	assert.match((harness.classifierHints[0]?.notes ?? []).join("\n"), /could not be parsed as shell/);
});

test("bypass attempts: comments, strings and continuation do not hide or invent commands", async () => {
	const deny = baseConfig({ permissionDeny: patterns("bash(rm -rf /*)") });

	const commentOnly = await setupHookTest({ config: deny });
	const quiet = await commentOnly.emit(
		"tool_call",
		evalCall("# subprocess.run(['rm', '-rf', '/*'])\nprint('os.system(\"rm -rf /*\")')"),
		commentOnly.ctx,
	) as HookResult;
	assert.equal(quiet, undefined, "mentions inside comments and strings are not commands");

	const hidden = [
		"import subprocess\nsubprocess.run(\n    ['rm',\n     '-rf',\n     '/*'],\n    check=True)",
		"import subprocess\nsubprocess.run(['rm', '-rf', \\\n    '/*'])",
		"import subprocess\nsubprocess.run('''rm -rf /*''', shell=True)",
		"import subprocess\nsubprocess.run('rm ' '-rf ' '/*', shell=True)",
		"import subprocess\nsubprocess.run('rm ' + '-rf ' + '/*', shell=True)",
		"import os\nos.system(\"rm -rf \\\n/*\")",
		"import os\nos.system('rm -rf /*')  # harmless",
		"import os\nx = '''\n'''\nos.system('rm -rf /*')",
	];
	for (const code of hidden) {
		const harness = await setupHookTest({ config: deny });
		const result = await harness.emit("tool_call", evalCall(code), harness.ctx) as HookResult;
		assert.equal(result?.block, true, code);
		assert.match(result?.reason ?? "", /permissions\.deny/, code);
	}
});
