import assert from "node:assert/strict";
import test from "node:test";
import { analyzeBash, deterministicHardDeny } from "../extensions/auto-mode.ts";

// Every place a shell can run a command must be visited, or the command is hidden
// from the hard-deny and permission checks. One probe command per location.
const HIDDEN_COMMAND_LOCATIONS: Array<[string, string]> = [
	["heredoc body", "cat <<EOF\n$(probe)\nEOF"],
	["heredoc body with a redirect", "cat <<EOF >out\n$(probe)\nEOF"],
	["here-string", "cat <<< \"$(probe)\""],
	["default operand", "echo ${x:-$(probe)}"],
	["remove operand", "echo ${x#$(probe)}"],
	["replace pattern", "echo ${x/$(probe)/y}"],
	["replace replacement", "echo ${x/a/$(probe)}"],
	["replace pattern with a slash in the substitution", "echo ${x/$(probe /)/y}"],
	["global replace pattern with a slash", "echo ${x//$(probe /a)/y}"],
	["slice offset", "echo ${x:$(probe)}"],
	["slice length", "echo ${x:1:$(probe)}"],
	["case modification operand", "echo ${x^^$(probe)}"],
	["transform operand", "echo ${x@$(probe)}"],
	["array index", "echo ${a[$(probe)]}"],
	["assignment index", "a[$(probe)]=1"],
	["assignment value", "A=$(probe) true"],
	["array assignment element", "A=(x $(probe)) true"],
	["declaration argument", "export A=$(probe)"],
	["declaration array argument", "declare -a A=(x $(probe))"],
	["argument index", "export A[$(probe)]=1"],
	["redirect target", "true > $(probe)"],
	["compound redirect target", "{ true; } > $(probe)"],
	["function redirect target", "f() { true; } > $(probe)"],
	["loop redirect target", "while true; do break; done > $(probe)"],
	["test operand", "[[ $(probe) == x ]]"],
	["logical test operand", "[[ a == b && $(probe) == c ]]"],
	["third logical test operand", "[[ a == b || c == d || $(probe) == e ]]"],
	["negated test operand", "[[ ! $(probe) == x ]]"],
	["grouped test operand", "[[ ( $(probe) == x ) ]]"],
	["if clause", "if $(probe); then true; fi"],
	["elif clause", "if false; then true; elif $(probe); then true; fi"],
	["elif body", "if false; then true; elif true; then $(probe); fi"],
	["second elif body", "if false; then :; elif false; then :; elif true; then $(probe); fi"],
	["else body", "if false; then true; else $(probe); fi"],
	["case pattern", "case x in $(probe)) true;; esac"],
	["case word", "case $(probe) in x) true;; esac"],
	["for word list", "for x in $(probe); do true; done"],
	["select word list", "select x in $(probe); do true; done"],
	["arithmetic for", "for ((i=$(probe);;)); do break; done"],
	["arithmetic command", "(( $(probe) ))"],
	["arithmetic expansion", "echo $(( $(probe) ))"],
	["process substitution", "cat <($(probe))"],
	["bracket glob", "echo [$(probe)]"],
	["double quoted", "echo \"$(probe)\""],
	["locale string", "echo $\"$(probe)\""],
	["brace expansion", "echo {a,$(probe)}"],
	["negated pipeline", "! $(probe)"],
	["timed pipeline", "time $(probe)"],
	["coproc body", "coproc { $(probe); }"],
	["coproc redirect", "coproc { true; } > $(probe)"],
	["subshell", "( $(probe) )"],
	["background statement", "$(probe) &"],
	["nested shell script", "bash -c '$(probe)'"],
];

test("commands in every syntax position are extracted", () => {
	for (const [location, source] of HIDDEN_COMMAND_LOCATIONS) {
		const analysis = analyzeBash(source);
		assert.ok(
			analysis.commands.some((command) => command.name === "probe") ||
				analysis.errors.length > 0,
			`${location}: ${source}`,
		);
	}
});

test("a deny rule's command is found in the positions where bash would run it", () => {
	for (const [location, source] of HIDDEN_COMMAND_LOCATIONS) {
		const hidden = source.replaceAll("probe", "rm -rf /");
		const reason = deterministicHardDeny("bash", { command: hidden }, "/tmp/project");
		assert.match(reason ?? "", /./, `${location}: ${hidden}`);
	}
});

test("redirects of compound commands and functions are group targets", () => {
	for (const source of [
		"{ true; } > out",
		"( true ) > out",
		"while true; do break; done > out",
		"f() { true; } > out",
		"coproc { true; } > out",
		"! { true; } > out",
	]) {
		assert.deepEqual(analyzeBash(source).groupWriteRedirectTargets, ["out"], source);
	}
	assert.deepEqual(analyzeBash("true > out").groupWriteRedirectTargets, []);
});

test("pipeline prefixes, elif chains, and compound redirects keep distinct structure", () => {
	const tokens = (source: string) => analyzeBash(source).structure.join(" ");
	assert.notEqual(tokens("! a"), tokens("a"));
	assert.notEqual(tokens("time a"), tokens("a"));
	assert.notEqual(tokens("! a"), tokens("time a"));
	assert.notEqual(tokens("if a; then b; fi"), tokens("if a; then b; elif c; then d; fi"));
	assert.notEqual(
		tokens("if a; then b; elif c; then d; fi"),
		tokens("if a; then b; elif c; then d; else e; fi"),
	);
	assert.notEqual(tokens("{ a; }"), tokens("{ a; } > out"));
});

test("a here-document delimiter is not an expandable word", () => {
	const quoted = analyzeBash("cat <<'EOF'\n$(probe)\nEOF");
	assert.equal(quoted.commands.some((command) => command.name === "probe"), false);
	assert.equal(analyzeBash("cat <<EOF\nx\nEOF").redirects[0]?.heredoc, true);
});

test("a NUL escape in an ANSI-C string is rejected even though the parser truncates it", () => {
	for (const escape of ["\\0", "\\00", "\\000", "\\400", "\\x0", "\\x00", "\\u0", "\\u0000", "\\U00000000", "\\c@", "\\c`", "\\c "]) {
		const analysis = analyzeBash(`echo $'a${escape}z'`);
		assert.match(analysis.errors[0]?.message ?? "", /NUL/, escape);
	}
	for (const escape of ["\\\\0", "\\x41", "\\101", "\\n", "\\u0041", "\\cA"]) {
		assert.deepEqual(analyzeBash(`echo $'a${escape}z'`).errors, [], escape);
	}
});

test("an unknown parameter expansion operator is unanalyzable", () => {
	assert.match(analyzeBash("echo ${x.y}").errors[0]?.message ?? "", /parameter expansion/);
	assert.deepEqual(analyzeBash("echo ${x:-a} ${x#a} ${#x} ${!x} ${x@Q} ${x^^}").errors, []);
});
