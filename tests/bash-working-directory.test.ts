import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { join } from "node:path";
import { baseConfig, createFakeCtx, setupHookTest } from "./test-helpers.ts";
import { deterministicHardDeny, parseToolPattern } from "../extensions/auto-mode.ts";

const permissionAllow = ["bash"].map((raw) => parseToolPattern(raw)!);

for (const command of [
	`cd / && rm -rf ${os.homedir().replace(/^\//, "")}`,
	"cd / && find -L etc -delete",
	"cd / && chmod 777 etc/passwd",
	"cd / && printf marker >> etc/profile",
	"command cd / && rm -rf etc",
	"builtin cd / && rm -rf etc",
	"cd /tmp || cd /; rm -rf etc",
	"bash -c 'cd / && rm -rf etc'",
	"for pass in 1 2; do cd /; done; printf marker >> etc/profile",
]) {
	test(`directory changes cannot bypass protected-path checks: ${command}`, async () => {
		const harness = await setupHookTest({
			config: baseConfig({ permissionAllow }),
			ctx: createFakeCtx([], { cwd: "/tmp/automode-project" }),
		});
		const result = await harness.emit("tool_call", {
			toolName: "bash", input: { command },
		}, harness.ctx) as { block?: boolean; reason?: string } | undefined;
		assert.equal(result?.block, true);
		assert.equal(harness.classifierCalls, 0);
	});
}

test("unresolved shell directory changes fail closed for relative destructive targets", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ permissionAllow }),
		ctx: createFakeCtx([], { cwd: "/tmp/automode-project" }),
	});
	for (const command of [
		'cd "$TARGET" && rm -rf relative-target',
		"popd && rm -rf relative-target",
		"cd - && rm -rf relative-target",
		"while test -n x; do cd ..; done; rm -rf relative-target",
		'cd "$TARGET" && printf marker >& relative-log',
	]) {
		const result = await harness.emit("tool_call", {
			toolName: "bash", input: { command },
		}, harness.ctx) as { block?: boolean; reason?: string } | undefined;
		assert.equal(result?.block, true, command);
	}
	assert.equal(harness.classifierCalls, 0);
});

test("trusted directory changes preserve routine builds and scoped temporary deletion", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ permissionAllow }),
		ctx: createFakeCtx([], { cwd: "/tmp/automode-project" }),
	});
	for (const command of [
		"cd /etc/nixos && git status",
		"cd /tmp && npm test",
		`cd ${JSON.stringify(os.tmpdir())} && rm -rf automode-created-output`,
	]) {
		assert.equal(await harness.emit("tool_call", {
			toolName: "bash", input: { command },
		}, harness.ctx), undefined, command);
	}
	assert.equal(harness.classifierCalls, 0);
});

test("unresolved directory changes allow redirects that open no file for writing", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ permissionAllow }),
		ctx: createFakeCtx([], { cwd: "/tmp/automode-project" }),
	});
	for (const command of [
		'cd "$TARGET" && make 2>&1 | tail -n 5',
		'cd "$TARGET" && make 2>&- >&2',
		'cd "$TARGET" && python3 - <<\'PY\'\nprint(1)\nPY',
		'cd "$TARGET" && grep -c x <<< "$INPUT"',
		'cd "$TARGET" && wc -l < relative-input.txt',
		"cd /tmp && for f in a b; do cd /tmp; printf '%s' \"$f\" > relative-out; done",
	]) {
		// The mock classifier allows, so a block here can only come from the
		// deterministic directory checks this test covers.
		assert.equal(await harness.emit("tool_call", {
			toolName: "bash", input: { command },
		}, harness.ctx), undefined, command);
	}
});

const projectDirectory = join(os.homedir(), "automode-project");
const UNRESOLVED = /unresolved directory change/;
const SYSTEM_PATH = /home\/root\/system|system-wide|system or SSH|user-home expansion/;
const UNRESOLVED_OR_SYSTEM_PATH = new RegExp(`${UNRESOLVED.source}|${SYSTEM_PATH.source}`);

function hardDeny(command: string): string | undefined {
	return deterministicHardDeny("bash", { command }, projectDirectory);
}

test("a later unresolved directory change does not affect earlier commands", () => {
	for (const command of [
		// Recorded false positive: a bare-name cd (CDPATH risk) follows the rm.
		"cd /tmp; rm -rf hd2; git clone -q --depth 50 https://example.com/org/repo.git hd2 && cd hd2 && git log --oneline -3 && grep -rn \"heartbeat\\|HEARTBEAT\" src | head -30; echo ---; grep -rn \"timeout\\|TIMEOUT\" src | head -40",
		// Recorded false positive: the same shape under a tilde directory.
		"H=$(git -C /tmp/x rev-parse --show-toplevel 2>/dev/null); R=$(echo -n ~/.omp/wt | true); mkdir -p ~/.omp/wt && cd ~/.omp/wt && rm -rf hb60-tmp && gh repo clone org/repo hb60-tmp 2>&1 | tail -1 && cd hb60-tmp && git fetch upstream -q && grep -rn \"DEFAULT_HEARTBEAT\" src docs tests | head -40",
		"rm -rf scratch; cd \"$TARGET\"",
		"printf x > relative-out; cd -",
		"rm -rf scratch; popd",
		"rm -rf scratch; pushd \"$TARGET\"",
		"rm -rf scratch; $runner --build",
		"rm -rf scratch; eval \"$script\"",
		"rm -rf scratch; . ./env.sh",
		"printf x > relative-out; source ./env.sh",
		"printf x > relative-out; HOME=/tmp cd",
		"printf x > relative-out; CDPATH=/ cd etc",
		"rm -rf scratch; cd /",
		"rm -rf scratch && cd / && ls",
		"rm -rf scratch; eval 'cd hd2'",
	]) {
		assert.equal(hardDeny(command), undefined, command);
	}
});

test("commands after an unresolved directory change stay hard-denied", () => {
	for (const command of [
		"cd hd2 && rm -rf relative-target",
		"cd /tmp; cd hd2; rm -rf relative-target",
		"cd \"$TARGET\"; printf x > relative-out",
		"rm -rf scratch; cd \"$TARGET\"; rm -rf relative-target",
		"rm -rf scratch; $runner --build; printf x > relative-out",
		"rm -rf scratch; eval \"$script\"; rm -rf relative-target",
		"printf x > relative-out; popd; rm -rf relative-target",
		"printf x > relative-out; CDPATH=/ cd etc; rm -rf relative-target",
		"printf x > relative-out; source ./env.sh; rm -rf relative-target",
		"printf x > relative-out; . ./env.sh; printf x > relative-out",
		"eval 'cd \"$TARGET\"'; rm -rf relative-target",
		"eval 'cd hd2; rm -rf relative-target'",
		"bash -c 'cd hd2'; rm -rf relative-target",
		"( cd \"$TARGET\" ); chmod 777 relative-target",
		"cd \"$TARGET\"; find relative-target -delete",
		"cd \"$TARGET\"; true; false || rm -rf relative-target",
		// An absolute cd cannot restore a directory that may never have changed.
		"cd \"$TARGET\"; cd /tmp; rm -rf relative-target",
	]) {
		assert.match(hardDeny(command) ?? "", UNRESOLVED, command);
	}
});

test("an earlier safe directory does not hide a later absolute directory change", () => {
	for (const command of [
		"cd / && rm -rf etc",
		"cd /tmp; cd / && rm -rf etc",
		"rm -rf scratch; cd / && rm -rf etc",
		"cd /tmp || cd /; rm -rf etc",
		"( cd / ); rm -rf etc",
		"cd /; cd /tmp; rm -rf etc",
		"cd \"$TARGET\" || cd /; rm -rf etc",
	]) {
		assert.match(hardDeny(command) ?? "", /home\/root\/system|unresolved/, command);
	}
});

test("a directory change after a command does not apply to that command", () => {
	// `etc` resolves under the project; the later cd / cannot reach back.
	assert.equal(hardDeny("rm -rf etc; cd /"), undefined);
	assert.equal(hardDeny("printf x > etc/profile; cd /"), undefined);
	assert.equal(hardDeny("find etc -delete; cd /"), undefined);
	assert.match(hardDeny("cd /; rm -rf etc") ?? "", /home\/root\/system/);
});

test("commands in loops and functions see directories reached later in the script", () => {
	for (const command of [
		"for pass in 1 2; do rm -rf etc; cd /; done",
		"while true; do rm -rf etc; cd /; done",
		"until false; do printf x >> etc/profile; cd /; done",
		"clean() { rm -rf etc; }; enter() { cd /; }; enter; clean",
		"clean() { printf x >> etc/profile; }; cd /; clean",
		"for pass in 1 2; do rm -rf relative-target; cd \"$TARGET\"; done",
		"clean() { rm -rf relative-target; }; cd \"$TARGET\"; clean",
		"for pass in 1 2; do ( rm -rf etc ); done; cd /",
		"for pass in 1 2; do echo $(rm -rf etc); done; cd /",
	]) {
		assert.notEqual(hardDeny(command), undefined, command);
	}
	// A relative cd in a loop has no finite set of targets.
	assert.match(
		hardDeny("for d in a b; do cd ..; done; rm -rf relative-target") ?? "",
		UNRESOLVED,
	);
	// A relative cd outside any loop still resolves, whatever loops exist.
	assert.equal(
		hardDeny("for f in a b; do echo $f; done; cd ..; rm -rf relative-target"),
		undefined,
	);
});

test("redirects on compound commands use every directory the script can reach", () => {
	assert.notEqual(hardDeny("{ true; } > etc/profile; cd /"), undefined);
	assert.match(hardDeny("{ true; } > relative-out; cd \"$TARGET\"") ?? "", UNRESOLVED);
	assert.match(hardDeny("cd \"$TARGET\"; { true; } > relative-out") ?? "", UNRESOLVED);
	assert.equal(hardDeny("{ true; } > relative-out"), undefined);
});

test("eval with a literal script is analyzed as part of the command", () => {
	assert.equal(hardDeny("eval 'cd /tmp; rm -rf scratch'"), undefined);
	assert.equal(hardDeny("eval cd /tmp '&&' rm -rf scratch"), undefined);
	for (const command of [
		"eval 'rm -rf /etc'",
		"eval 'cd /; rm -rf etc'",
		"eval cd / '&&' rm -rf etc",
		"eval 'eval \"cd /\"; rm -rf etc'",
		"eval 'printf x >> ~/.bashrc'",
		"eval 'cd \"$T\"'; rm -rf relative-target",
		"eval 'cd /'; rm -rf etc",
	]) {
		assert.notEqual(hardDeny(command), undefined, command);
	}
});

test("a dynamic command name only affects the commands after it", () => {
	// Recorded false positive: the whole script ran inside `eval '…'`.
	const script = [
		"py=/usr/bin/python3",
		"d=$(mktemp -d)",
		"printf '%s' data > $d/gen.yml",
		"printf '%s' more > $d/live.yml",
		"$py tool.py $d/gen.yml $d/live.yml",
		"cat $d/live.yml",
		": > $d/empty.yml",
		"$py tool.py $d/gen.yml $d/empty.yml",
		"echo \"empty rc=$? size=$(stat -c%s $d/empty.yml)\"",
		"rm -rf $d/live.yml",
	].join("; ");
	assert.equal(hardDeny(`eval '${script.replaceAll("'", "'\\''")}'`), undefined);
	assert.equal(hardDeny(script), undefined);
	assert.match(hardDeny(`${script}; rm -rf relative-target`) ?? "", UNRESOLVED);
	assert.match(hardDeny(`$py x; printf x > relative-out`) ?? "", UNRESOLVED);
});

test("paths led by a variable are checked as if the variable were empty after an unresolved directory change", () => {
	for (const command of [
		"cd \"$TARGET\"; printf x > $d/out.yml",
		"cd \"$TARGET\"; printf x > ${d}/out.yml",
		"cd \"$TARGET\"; printf x > \"$d/out.yml\"",
		"cd \"$TARGET\"; printf x > \"$d\"/out.yml",
		"cd \"$TARGET\"; : > $d/nested/dir/out.yml",
		"cd \"$TARGET\"; rm -rf $d",
		"cd \"$TARGET\"; rm -rf \"$d\"",
		"cd \"$TARGET\"; rm -rf $d/sub",
		"cd \"$TARGET\"; rm -rf ${d}/sub",
		"cd \"$TARGET\"; rm -rf \"$d/sub\"",
		"cd \"$TARGET\"; rm -rf $TMPDIR/scratch",
		"cd \"$TARGET\"; find $d -delete",
		"cd \"$TARGET\"; find $d/sub -delete",
		"cd \"$TARGET\"; printf x > $HOME/scratch/out",
	]) {
		assert.equal(hardDeny(command), undefined, command);
	}
	for (const command of [
		// An empty or unset variable turns these into root, home, or system paths.
		"cd \"$TARGET\"; rm -rf \"$d\"/",
		"cd \"$TARGET\"; rm -rf \"$d/\"",
		"cd \"$TARGET\"; rm -rf $d/..",
		"cd \"$TARGET\"; rm -rf $d/../etc",
		"cd \"$TARGET\"; rm -rf ${d}/etc",
		"cd \"$TARGET\"; rm -rf $d/etc/passwd",
		"cd \"$TARGET\"; rm -rf $d/usr",
		"cd \"$TARGET\"; find \"$d\"/ -delete",
		"cd \"$TARGET\"; find $d/etc -delete",
		// A variable that names the working directory is still relative.
		"cd \"$TARGET\"; rm -rf $PWD/sub",
		"cd \"$TARGET\"; rm -rf ${PWD}/sub",
		"cd \"$TARGET\"; rm -rf $OLDPWD",
		"cd \"$TARGET\"; printf x > $PWD/out",
		"cd \"$TARGET\"; printf x > ${OLDPWD}/out",
		// Computed or composite leading words stay unresolved.
		"cd \"$TARGET\"; rm -rf ${d:-/}",
		"cd \"$TARGET\"; rm -rf $(mktemp -d)/sub",
		"cd \"$TARGET\"; printf x > $(mktemp -d)/out",
		"cd \"$TARGET\"; printf x > ${d:-out}/f",
		"cd \"$TARGET\"; printf x > pre$d/out",
		"cd \"$TARGET\"; rm -rf ./$d/sub",
		"cd \"$TARGET\"; rm -rf ~user/sub",
	]) {
		assert.match(hardDeny(command) ?? "", UNRESOLVED_OR_SYSTEM_PATH, command);
	}
});

test("protected paths stay denied after an unresolved directory change", () => {
	for (const command of [
		"cd \"$TARGET\"; printf x >> ~/.bashrc",
		"cd \"$TARGET\"; printf x >> $HOME/.zshrc",
		"cd \"$TARGET\"; printf x >> ${HOME}/.ssh/authorized_keys",
		"cd \"$TARGET\"; printf x > /tmp/automode-project/auto-mode.json",
	]) {
		assert.notEqual(hardDeny(command), undefined, command);
	}
});

test("a known working directory treats variable-led paths as before", () => {
	assert.equal(hardDeny("rm -rf $d/etc"), undefined);
	assert.equal(hardDeny("printf x > $d/out.yml"), undefined);
	assert.match(hardDeny("cd /; rm -rf $d/../etc") ?? "", SYSTEM_PATH);
});

test("the hook lets commands past hard-deny when only a later directory change is unresolved", async () => {
	const harness = await setupHookTest({
		config: baseConfig({ permissionAllow }),
		ctx: createFakeCtx([], { cwd: projectDirectory }),
	});
	const allowed = "cd /tmp; rm -rf hd2; git clone -q https://example.com/org/repo.git hd2 && cd hd2 && git log --oneline -3";
	assert.equal(await harness.emit("tool_call", {
		toolName: "bash", input: { command: allowed },
	}, harness.ctx), undefined);
	const blocked = await harness.emit("tool_call", {
		toolName: "bash", input: { command: "cd hd2; rm -rf relative-target" },
	}, harness.ctx) as { block?: boolean; reason?: string } | undefined;
	assert.equal(blocked?.block, true);
	assert.match(blocked?.reason ?? "", /unresolved directory change/);
	assert.equal(harness.classifierCalls, 0);
});
