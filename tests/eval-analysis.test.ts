import assert from "node:assert/strict";
import test from "node:test";
import {
	MAX_EVAL_ANALYSIS_LENGTH,
	analyzeEval,
	describeEvalAnalysis,
	evalCodeTexts,
	normalizeEvalLanguage,
	parseEvalPattern,
	shellQuoteWord,
	type EvalAnalysis,
} from "../extensions/auto-mode/eval-analysis.ts";

function py(code: string) {
	return analyzeEval({ language: "py", code });
}

function js(code: string) {
	return analyzeEval({ language: "js", code });
}

function commands(analysis: EvalAnalysis): string[] {
	return analysis.commands.map((entry) => entry.command);
}

function assertOpaque(analysis: EvalAnalysis, pattern?: RegExp, message?: string) {
	assert.ok(analysis.opaqueReasons.length > 0, message ?? "expected an opaque verdict");
	if (pattern) {
		assert.ok(
			analysis.opaqueReasons.some((reason) => pattern.test(reason)),
			`${message ?? ""} reasons: ${analysis.opaqueReasons.join(" | ")}`,
		);
	}
}

function assertClean(analysis: EvalAnalysis, expected: string[]) {
	assert.deepEqual(analysis.opaqueReasons, []);
	assert.deepEqual(commands(analysis), expected);
}

test("language tokens normalize and unknown tokens are rejected", () => {
	assert.equal(normalizeEvalLanguage("py"), "py");
	assert.equal(normalizeEvalLanguage(" Python "), "py");
	assert.equal(normalizeEvalLanguage("JS"), "js");
	assert.equal(normalizeEvalLanguage("javascript"), "js");
	assert.equal(normalizeEvalLanguage("ruby"), undefined);
	assert.equal(normalizeEvalLanguage(undefined), undefined);
});

test("eval pattern scope accepts a language prefix and nothing else", () => {
	assert.deepEqual(parseEvalPattern("py: subprocess*"), { language: "py", codePattern: "subprocess*" });
	assert.deepEqual(parseEvalPattern("JS:*rm*"), { language: "js", codePattern: "*rm*" });
	assert.deepEqual(parseEvalPattern("python:x"), { language: "py", codePattern: "x" });
	assert.deepEqual(parseEvalPattern("*py: x*"), { codePattern: "*py: x*" });
	assert.deepEqual(parseEvalPattern("ruby: x"), { codePattern: "ruby: x" });
	assert.deepEqual(parseEvalPattern("py:"), { language: "py", codePattern: "" });
});

test("shell quoting keeps globs and tilde live but quotes everything risky", () => {
	assert.equal(shellQuoteWord("/*"), "/*");
	assert.equal(shellQuoteWord("~"), "~");
	assert.equal(shellQuoteWord("a b"), "'a b'");
	assert.equal(shellQuoteWord(""), "''");
	assert.equal(shellQuoteWord("it's"), "'it'\\''s'");
	assert.equal(shellQuoteWord("$HOME"), "'$HOME'");
	assert.equal(shellQuoteWord("a;b"), "'a;b'");
	assert.equal(shellQuoteWord("FOO=bar", true), "'FOO=bar'");
	assert.equal(shellQuoteWord("-rf"), "-rf");
});

test("python subprocess argv lists render as quoted command lines", () => {
	assertClean(py("import subprocess\nsubprocess.run(['rm', '-rf', '/*'])"), ["rm -rf /*"]);
	assertClean(py("import subprocess\nsubprocess.check_output((\"git\", \"push\", \"--force\"))"), ["git push --force"]);
	assertClean(py("import subprocess\nsubprocess.Popen(['echo', 'a b', \"it's\"])"), ["echo 'a b' 'it'\\''s'"]);
	assertClean(py("import subprocess\nsubprocess.call(args=['ls', '-la'])"), ["ls -la"]);
	assertClean(py("import subprocess\nsubprocess.check_call(['a',\n  'b',\n],\n check=True)"), ["a b"]);
});

test("python subprocess strings are shell text with or without shell=True", () => {
	assertClean(py("import subprocess\nsubprocess.run('git push origin main', shell=True)"), ["git push origin main"]);
	assertClean(py("import subprocess\nsubprocess.run('git status')"), ["git status"]);
	assertClean(py("import subprocess\nsubprocess.getoutput('ls | wc -l')"), ["ls | wc -l"]);
	assertClean(py("import subprocess\nsubprocess.getstatusoutput('ls')"), ["ls"]);
	assertClean(py("import subprocess\nsubprocess.run(['rm -rf /tmp/x', 'ignored'], shell=True)"), ["rm -rf /tmp/x"]);
});

test("python cwd literals become a leading cd", () => {
	assertClean(
		py("import subprocess\nsubprocess.run(['rm', '-rf', '.'], cwd='/tmp/work')"),
		["cd /tmp/work && rm -rf ."],
	);
	assertOpaque(py("import subprocess\nsubprocess.run(['rm', '-rf', '.'], cwd=where)"), /cwd/);
});

test("python os.system, os.popen and the runner shell helper are shell strings", () => {
	assertClean(py("import os\nos.system('rm -rf ~')"), ["rm -rf ~"]);
	assertClean(py("import os\nout = os.popen('ls').read()"), ["ls"]);
	assertClean(py("__omp_shell('echo hi')"), ["echo hi"]);
	assertClean(py("import asyncio\nawait asyncio.create_subprocess_shell('ls | sort')"), ["ls | sort"]);
	assertClean(py("import asyncio\nawait asyncio.create_subprocess_exec('git', 'push')"), ["git push"]);
});

test("python IPython shell escapes and %%bash cells are extracted", () => {
	assertClean(py("!rm -rf /tmp/foo"), ["rm -rf /tmp/foo"]);
	assertClean(py("files = !ls -la"), ["ls -la"]);
	assertClean(py("    !echo one \\\n    two"), ["echo one     two"]);
	assertClean(py("%%bash\nrm -rf /\necho done\n"), ["rm -rf /\necho done\n"]);
	assertOpaque(py("%%capture out\nprint(1)"), /cell magic/);
	assertOpaque(py("%pip install requests"), /magic %pip/);
	assertOpaque(py("%load script.py"), /magic %load/);
	assertOpaque(py("%run script.py"), /magic %run/);
	assertOpaque(py("%cd /"), /magic %cd/);
	assertOpaque(py("x = %time subprocess.run(['ls'])"), /magic %time/);
});

test("python != and format conversions are not mistaken for shell escapes", () => {
	assertClean(py("a = 1\nif a != 2:\n    print(f'{a!r}')"), []);
	assertClean(py("x = 5 % 3\nprint('100%')"), []);
});

test("python string concatenation of literals folds, anything computed is opaque", () => {
	assertClean(py("import subprocess\nsubprocess.run('rm ' '-rf /')"), ["rm -rf /"]);
	assertClean(py("import subprocess\nsubprocess.run('rm ' + '-rf ' + '/')"), ["rm -rf /"]);
	assertClean(py("import subprocess\nsubprocess.run(('rm -rf ' + '/tmp/x'), shell=True)"), ["rm -rf /tmp/x"]);
	assertOpaque(py("import subprocess\nsubprocess.run('rm -rf ' + path, shell=True)"), /not a literal/);
	assertOpaque(py("import subprocess\nsubprocess.run('rm %s' % path, shell=True)"), /not a literal/);
	assertOpaque(py("import subprocess\nsubprocess.run('rm {}'.format(path), shell=True)"), /not a literal/);
	assertOpaque(py("import subprocess\nsubprocess.run(' '.join(['rm', x]), shell=True)"), /not a literal/);
	assertOpaque(py("import subprocess\nsubprocess.run(['rm', x])"), /not a literal/);
	assertOpaque(py("import subprocess\nsubprocess.run(['rm'] + extra)"), /not a literal/);
});

test("python f-strings with interpolation are opaque; plain f-strings are literal", () => {
	assertOpaque(py("import subprocess\nsubprocess.run(f'rm -rf {path}', shell=True)"), /not a literal/);
	assertOpaque(py("import subprocess\nsubprocess.run(f\"echo {{x}} {y}\", shell=True)"), /not a literal/);
	assertClean(py("import subprocess\nsubprocess.run(f'ls -la')"), ["ls -la"]);
});

test("python f-string expressions are scanned for hidden calls", () => {
	const nested = py("print(f\"{os.system('rm -rf /')}\")");
	assertClean(nested, ["rm -rf /"]);
	assertOpaque(py("print(f\"{__import__('os').system('ls')}\")"), /__import__/);
	assertOpaque(py("print(f\"{getattr(os, 'sys' + 'tem')('ls')}\")"), /getattr/);
});

test("python shell=True with a computed command is opaque", () => {
	assertOpaque(py("import subprocess\ncmd = 'rm -rf /'\nsubprocess.run(cmd, shell=True)"), /not a literal/);
	assertOpaque(py("import subprocess\nsubprocess.run('ls', shell=flag)"), /shell=/);
	assertOpaque(py("import subprocess\nsubprocess.run(*args)"), /unpacking|not a literal/);
	assertOpaque(py("import subprocess\nsubprocess.run(**kwargs)"), /unpacking/);
});

test("python indirection and dynamic execution is opaque", () => {
	assertOpaque(py("import subprocess\ngetattr(subprocess, 'run')(['ls'])"), /getattr/);
	assertOpaque(py("__import__('os').system('ls')"), /__import__/);
	assertOpaque(py("import importlib\nimportlib.import_module('os').system('ls')"), /importlib/);
	assertOpaque(py("exec('import os')"), /exec/);
	assertOpaque(py("eval('1+1')"), /eval/);
	assertOpaque(py("compile('x', 'f', 'exec')"), /compile/);
	assertOpaque(py("import ctypes"), /ctypes/);
	assertOpaque(py("import pty\npty.spawn(['sh'])"), /pty/);
	assertOpaque(py("globals()['x']"), /globals/);
	assertOpaque(py("vars(os)['system']('ls')"), /vars/);
	assertOpaque(py("sys.modules['os'].system('ls')"), /sys\.modules/);
	assertOpaque(py("().__class__.__bases__[0].__subclasses__()"), /__bases__|__subclasses__/);
	assertOpaque(py("__builtins__.__dict__['exec']"), /__builtins__|__dict__/);
	assertOpaque(py("get_ipython().system('ls')"), /get_ipython/);
	assertOpaque(py("__omp_magic('run', 'x.py')"), /__omp_magic/);
});

test("python aliases of subprocess and os are opaque", () => {
	assertOpaque(py("import subprocess as sp\nsp.run(['ls'])"), /aliased/);
	assertOpaque(py("import os as o\no.system('ls')"), /aliased/);
	assertOpaque(py("from subprocess import run\nrun(['ls'])"), /aliased/);
	assertOpaque(py("from subprocess import *"), /aliased/);
	assertOpaque(py("from os import system\nsystem('ls')"), /from os import system/);
	assertOpaque(py("from os import (path,\n  popen)"), /from os import popen/);
	assertOpaque(py("from os import *"), /from os import \*/);
	assertOpaque(py("import subprocess\nrunner = subprocess.run\nrunner(['ls'])"), /without a literal call/);
	assertOpaque(py("import subprocess\nrunner = subprocess\nrunner.run(['ls'])"), /aliased/);
	assertOpaque(py("import os\nrunner = os.system\nrunner('ls')"), /os\.system/);
	assertOpaque(py("import os\no = os\no.system('ls')"), /aliased/);
	assertOpaque(py("import os\nos.execvp('ls', ['ls'])"), /os\.execvp/);
	assertOpaque(py("import os\nos.spawnl(os.P_WAIT, '/bin/ls', 'ls')"), /os\.spawnl/);
	assertOpaque(py("import os\nos.posix_spawn('/bin/ls', ['ls'], {})"), /os\.posix_spawn/);
	assertOpaque(py("import os\nos.fork()"), /os\.fork/);
	assertOpaque(py("import os\nos.chdir('/')"), /os\.chdir/);
});

test("python identifiers are NFKC-normalized like the interpreter does", () => {
	assertClean(py("import subprocess\n\uff53ubprocess.run(['ls'])"), ["ls"]);
	assertOpaque(py("import subprocess\n\uff53ubprocess.PIPEX"), /without a literal call/);
	assertOpaque(py("import \uff4fs as x"), /aliased/);
});

test("python subprocess options that change what runs are opaque but the command is still extracted", () => {
	const withEnv = py("import subprocess\nsubprocess.run(['ls'], env={'LD_PRELOAD': 'x'})");
	assert.deepEqual(commands(withEnv), ["ls"]);
	assertOpaque(withEnv, /env=/);
	const withExecutable = py("import subprocess\nsubprocess.run(['ls'], executable='/bin/evil')");
	assert.deepEqual(commands(withExecutable), ["ls"]);
	assertOpaque(withExecutable, /executable=/);
	assertOpaque(py("import subprocess\nsubprocess.Popen(['ls'], preexec_fn=f)"), /preexec_fn=/);
	assertOpaque(py("import subprocess\nsubprocess.Popen(['ls'], 0, '/bin/evil')"), /positional/);
	assertClean(
		py("import subprocess\nsubprocess.run(['ls'], capture_output=True, text=True, check=True, timeout=5)"),
		["ls"],
	);
	assertClean(
		py("import subprocess\nsubprocess.run(['ls'], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)"),
		["ls"],
	);
});

test("python nested subprocess calls are all visited", () => {
	const nested = py("import subprocess\nsubprocess.run(['echo', subprocess.check_output(['whoami'])])");
	assert.deepEqual(commands(nested), ["whoami"]);
	assertOpaque(nested, /not a literal/);
});

test("python comments and docstrings that mention subprocess never create commands", () => {
	assertClean(py("# subprocess.run(['rm', '-rf', '/'])\nprint(1)"), []);
	assertClean(py("x = '''\nsubprocess.run(['rm'])\nos.system('x')\n'''\nprint(x)"), []);
	assertClean(py("print('subprocess.run([\"rm\"])')"), []);
	assertClean(py('"""doc: os.system(\'x\') getattr eval"""'), []);
	assertClean(py("x = 'a'  # getattr(os, 'system')"), []);
});

test("python escaped quotes, raw strings and line continuations are decoded like the interpreter", () => {
	assertClean(py("import os\nos.system('echo \\'hi\\'')"), ["echo 'hi'"]);
	assertClean(py("import os\nos.system(\"echo \\\"hi\\\"\")"), ['echo "hi"']);
	assertClean(py("import os\nos.system(r'echo \\n')"), ["echo \\n"]);
	assertClean(py("import os\nos.system('echo \\x41\\u0042\\103')"), ["echo ABC"]);
	assertClean(py("import os\nos.system('rm -rf \\\n/tmp/x')"), ["rm -rf /tmp/x"]);
	assertClean(py("import os\nos.system('''rm -rf\n/tmp/x''')"), ["rm -rf\n/tmp/x"]);
	assertClean(py("import os\nos\\\n.system('ls')"), ["ls"]);
	assertClean(py("import os\nos.system(b'ls')"), ["ls"]);
	assertOpaque(py("import os\nos.system('\\N{BULLET}')"), /not a literal/);
});

test("python lexical failures keep earlier commands and are opaque", () => {
	const broken = py("import os\nos.system('ls')\nx = 'unterminated");
	assert.deepEqual(commands(broken), ["ls"]);
	assertOpaque(broken, /could not be tokenized/);
	assertOpaque(py("import os\nos.system('ls'"), /not balanced/);
	assertOpaque(py("x = f'{'"), /tokenized/);
});

test("python harmless code stays clean", () => {
	assertClean(
		py("import os, sys, re, json\nfrom pathlib import Path\nprint(os.path.join('a', 'b'), os.environ.get('HOME'), platform.system())\nre.compile('x')\nPath('x').read_text()"),
		[],
	);
	assertClean(py("from os import path, environ\nprint(path.join('a'))"), []);
	assertClean(py("import os.path\nprint(os.path.sep)"), []);
});

test("javascript child_process destructured and namespace forms", () => {
	assertClean(js("const { execSync } = require('child_process');\nexecSync('rm -rf /')"), ["rm -rf /"]);
	assertClean(js("const cp = require('node:child_process');\ncp.spawnSync('git', ['push', '--force'])"), ["git push --force"]);
	assertClean(js("import { exec } from 'child_process';\nexec('ls | wc -l')"), ["ls | wc -l"]);
	assertClean(js("import * as cp from \"node:child_process\";\ncp.execFileSync('rm', ['-rf', '/*'])"), ["rm -rf /*"]);
	assertClean(js("import cp from 'child_process';\ncp.execSync('ls')"), ["ls"]);
	assertClean(js("const c = (await import('child_process')).execSync('ls')"), ["ls"]);
	assertClean(js("require('child_process').execSync('git status')"), ["git status"]);
	assertClean(js("const { spawn: sp } = require('child_process');\nsp('sh', ['-c', 'rm -rf /'])"), ["sh -c 'rm -rf /'"]);
	assertClean(js("import { exec as run } from 'child_process';\nrun('ls')"), ["ls"]);
});

test("javascript spawn options: cwd prefix, shell joins unquoted, unknown options are opaque", () => {
	assertClean(js("execSync('ls', { cwd: '/tmp/x', encoding: 'utf8' })"), ["cd /tmp/x && ls"]);
	assertClean(js("spawnSync('echo', ['a;b'])"), ["echo 'a;b'"]);
	assertClean(js("spawnSync('echo', ['a;b'], { shell: true })"), ["echo a;b"]);
	assertOpaque(js("execSync('ls', { cwd })"), /options use shorthand/);
	assertOpaque(js("execSync('ls', { cwd: dir })"), /cwd option/);
	assertOpaque(js("execSync('ls', { ...opts })"), /spread/);
	assertOpaque(js("execSync('ls', { env: process.env })"), /env option/);
	assertOpaque(js("execSync('ls', opts)"), /not an object literal/);
});

test("javascript dynamic commands are opaque", () => {
	assertOpaque(js("const x = 'a'; require('child_process').execSync(x)"), /not a literal/);
	assertOpaque(js("execSync(`echo ${x}`)"), /not a literal/);
	assertOpaque(js("execSync('rm ' + dir)"), /not a literal/);
	assertOpaque(js("spawnSync('rm', args)"), /not literal/);
	assertOpaque(js("execSync(...parts)"), /spread/);
	assertClean(js("execSync('rm -rf ' + '/tmp/x')"), ["rm -rf /tmp/x"]);
	assertClean(js("execSync(`rm -rf /tmp/x`)"), ["rm -rf /tmp/x"]);
	assertClean(js("execSync(\"echo \\\"hi\\\"\")"), ['echo "hi"']);
	assertClean(js("execSync('rm -rf \\\n/tmp/x')"), ["rm -rf /tmp/x"]);
});

test("javascript aliases, value uses and computed access are opaque", () => {
	assertOpaque(js("const cp = require('child_process'); const f = cp.exec; f('x')"), /exec is used outside|used as a value/);
	assertOpaque(js("const cp = require('child_process'); cp['exec']('x')"), /computed member/);
	assertOpaque(js("const cp = require('child_process'); run(cp)"), /used as a value/);
	assertOpaque(js("const { exec } = require('child_process'); promisify(exec)"), /exec is used outside/);
	assertOpaque(js("const m = 'child_process'; require(m).execSync('ls')"), /non-literal module/);
	assertOpaque(js("const r = require; r('child_process')"), /require is used as a value/);
	assertOpaque(js("await import(name)"), /non-literal module/);
	assertOpaque(js("const { fork } = require('child_process'); fork('x.js')"), /Node script/);
	assertOpaque(js("eval('1')"), /eval/);
	assertOpaque(js("new Function('return 1')()"), /Function/);
	assertOpaque(js("require('vm').runInThisContext('1')"), /vm/);
	assertOpaque(js("process.binding('spawn_sync')"), /process\.binding/);
	assertOpaque(js("process['binding']('x')"), /computed process/);
	assertOpaque(js("globalThis.process.binding('spawn_sync')"), /process\.binding/);
	assertClean(js("console.log(process.env.HOME, process.cwd(), typeof process)"), []);
	assertOpaque(js("process.chdir('/')"), /process\.chdir/);
	assertOpaque(js("const { dlopen } = process; dlopen()"), /process is aliased/);
});

test("javascript method names that are not child_process stay clean", () => {
	assertClean(js("const m = /a(b)/.exec('ab');\nconst n = re.exec(line);\nconsole.log(m, n)"), []);
	assertClean(js("const x = obj.spawn;\nconsole.log(x)"), []);
	assertClean(js("const t = `execSync('x')`; // execSync('rm -rf /')\n/* spawn('x') */\nconsole.log(t)"), []);
	assertClean(js("console.log('child_process', \"execSync('ls')\")"), []);
	assertClean(js("const a = 4 / 2 / 1; const b = a++ / 2; console.log(a, b, /x/g.test('x'))"), []);
});

test("javascript commands inside template interpolations and callbacks are found", () => {
	assertClean(js("console.log(`out: ${execSync('rm -rf /tmp/x')}`)"), ["rm -rf /tmp/x"]);
	assertClean(js("exec('ls', (err, out) => { exec('whoami') })"), ["ls", "whoami"]);
	assertClean(js("`a ${`b ${execSync('ls')}`}`"), ["ls"]);
});

test("Bun shell templates and Bun.spawn", () => {
	assertClean(js("await Bun.$`rm -rf /tmp/x`"), ["rm -rf /tmp/x"]);
	assertClean(js("await $`git push --force`.text()"), ["git push --force"]);
	assertClean(js("await Bun.$`echo \\`x\\``"), ["echo \\`x\\`"]);
	assertClean(js("Bun.spawn(['rm', '-rf', '/'], { cwd: '/tmp' })"), ["cd /tmp && rm -rf /"]);
	assertClean(js("Bun.spawnSync({ cmd: ['git', 'push'] })"), ["git push"]);
	assertOpaque(js("const d = 'x'; await Bun.$`rm -rf ${d}`"), /not a literal template/);
	assertOpaque(js("await $`rm -rf ${d}`"), /interpolation/);
	assertOpaque(js("const sh = $; sh`ls`"), /Bun shell/);
	assertOpaque(js("await $.cwd('/')`rm -rf *`"), /Bun shell/);
	assertOpaque(js("Bun.spawn(cmd)"), /not literal/);
	assertOpaque(js("Bun.spawn(['ls'], { env })"), /shorthand/);
	assertOpaque(js("const B = Bun; B.spawn(['ls'])"), /Bun is aliased/);
	assertOpaque(js("Bun['spawn'](['ls'])"), /Bun is aliased/);
	assertOpaque(js("const { spawn } = Bun"), /Bun is aliased/);
	assertOpaque(js("Bun.dlopen('x', {})"), /dlopen/);
	assertClean(js("const f = Bun.file('x'); await Bun.write('y', await f.text())"), []);
	assertClean(js("import { $ } from 'bun';\nawait $`ls`"), ["ls"]);
	assertOpaque(js("import { $ as sh } from 'bun';\nawait sh`ls`"), /renamed/);
});

test("javascript regular expressions with quotes do not hide later code", () => {
	assertClean(js("const r = /'/; execSync('rm -rf /tmp/x')"), ["rm -rf /tmp/x"]);
	assertClean(js("if (/\"/.test(s)) execSync('whoami')"), ["whoami"]);
});

test("javascript lexical failures are opaque", () => {
	const broken = js("execSync('ls'); const s = 'unterminated");
	assert.deepEqual(commands(broken), ["ls"]);
	assertOpaque(broken, /could not be tokenized/);
	assertOpaque(js("const s = `unterminated ${x"), /tokenized/);
	assertOpaque(js("/* unterminated"), /tokenized/);
	assertOpaque(js("\\u0065xecSync('ls')"), /tokenized/);
});

test("javascript percent commands are opaque", () => {
	assertOpaque(js("%load script.js"), /percent command/);
	assertOpaque(js("%bun add left-pad"), /percent command/);
});

test("unknown or missing language scans both languages and reports both", () => {
	const unknown = analyzeEval({ code: "import os\nos.system('ls')\nexecSync('whoami')" });
	assert.deepEqual(commands(unknown).sort(), ["ls", "whoami"]);
	const odd = analyzeEval({ language: "ruby", code: "system('ls')" });
	assertOpaque(odd, /language is not recognized/);
});

test("malformed eval inputs are opaque", () => {
	assertOpaque(analyzeEval({}), /no recognizable code/);
	assertOpaque(analyzeEval({ language: "py", code: 42 }), /no string code/);
	assertOpaque(analyzeEval({ language: "py", code: "x", cells: "nope" }), /cells is not an array/);
	assertOpaque(analyzeEval({ language: "py", code: "x", cells: [null] }), /not an object/);
});

test("multiple cells are all analyzed and joined for matching", () => {
	const analysis = analyzeEval({
		language: "py",
		cells: [
			{ code: "import os\nos.system('ls')" },
			{ code: "import subprocess\nsubprocess.run(['whoami'])", language: "py" },
		],
	});
	assert.deepEqual(commands(analysis), ["ls", "whoami"]);
	assert.equal(analysis.codeTexts.length, 2);
	assert.deepEqual(evalCodeTexts({ language: "py", code: "x" }), ["x"]);
});

test("a cell can contain many commands and all are returned", () => {
	const code = [
		"import subprocess, os",
		"subprocess.run(['ls'])",
		"os.system('whoami')",
		"!date",
	].join("\n");
	assert.deepEqual(commands(py(code)).sort(), ["date", "ls", "whoami"]);
});

test("oversized code is opaque without running the scanner", () => {
	const analysis = py(`x = '${"a".repeat(MAX_EVAL_ANALYSIS_LENGTH)}'`);
	assertOpaque(analysis, /exceeds/);
	assert.deepEqual(analysis.commands, []);
});

test("too many embedded commands become an opaque verdict", () => {
	const code = "import os\n" + Array.from({ length: 150 }, () => "os.system('ls')").join("\n");
	const analysis = py(code);
	assert.equal(analysis.commands.length, 100);
	assertOpaque(analysis, /more than 100/);
});

test("classifier notes describe opaque reasons and quote commands as data", () => {
	const analysis = py("import os\nos.system('rm -rf /')\nexec(code)");
	const notes = describeEvalAnalysis(analysis).join("\n");
	assert.match(notes, /opaque/);
	assert.match(notes, /os\.system: "rm -rf \/"/);
	assert.deepEqual(describeEvalAnalysis(py("print(1)")), []);
});

test("adversarial scanner inputs terminate", () => {
	const inputs = [
		"(".repeat(5000),
		"[".repeat(5000) + "]".repeat(5000),
		"subprocess.run(" + "(".repeat(2000),
		"f'" + "{".repeat(500) + "'",
		"`" + "${".repeat(300),
		"'''" + "\\".repeat(1000),
		"\\".repeat(4000),
		"%%",
		"!",
		"%",
	];
	for (const code of inputs) {
		for (const language of ["py", "js"]) {
			const analysis = analyzeEval({ language, code });
			assert.ok(Array.isArray(analysis.opaqueReasons));
		}
	}
});
