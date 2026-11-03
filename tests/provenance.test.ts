import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	CLASSIFIER_CREATED_PATHS_LIMIT,
	CREATED_PATHS_LIMIT,
	HOME,
	STATE_ENTRY,
	analyzeBash,
	claimsFromBash,
	claimsFromWrite,
	confirmCreations,
	createPiAutomode,
	defaultClassifyAction,
	formatSessionCreatedPaths,
	recordCreatedPaths,
	restoreState,
	snapshotCreations,
	type ClassifyAction,
	type EffectiveConfig,
} from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

const WORK = "/work";

function claimed(command: string, cwd = WORK): string[] {
	return claimsFromBash(analyzeBash(command), cwd).paths.map((claim) => claim.path);
}

function withTempDir<T>(run: (base: string) => T | Promise<T>): Promise<T> {
	const base = realpathSync(mkdtempSync(join(os.tmpdir(), "provenance-test-")));
	return Promise.resolve(run(base)).finally(() => rmSync(base, { recursive: true, force: true }));
}

test("mkdir claims every operand, with -p and combined flags", () => {
	assert.deepEqual(claimed("mkdir foo"), ["/work/foo"]);
	assert.deepEqual(claimed("mkdir -p /tmp/a/b /tmp/c"), ["/tmp/a/b", "/tmp/c"]);
	assert.deepEqual(claimed("mkdir -pv -m 755 out/x"), ["/work/out/x"]);
	assert.deepEqual(claimed("mkdir --parents --mode=700 -- -odd"), ["/work/-odd"]);
	const claims = claimsFromBash(analyzeBash("mkdir -p a && mkdir b"), WORK).paths;
	assert.deepEqual(claims.map((claim) => claim.createsParents), [true, false]);
});

test("cd in a straight-line chain moves the base for later relative claims", () => {
	assert.deepEqual(
		claimed("cd /tmp && mkdir -p foo && git clone https://github.com/o/r.git bar"),
		["/tmp/foo", "/tmp/bar"],
	);
	assert.deepEqual(claimed("cd sub; cd ../other\nmkdir x", "/work/proj"), ["/work/proj/other/x"]);
	assert.deepEqual(claimed("cd && mkdir x"), [`${HOME}/x`]);
	assert.deepEqual(claimed("cd ~/code && mkdir x"), [`${HOME}/code/x`]);
});

test("cd that cannot be followed leaves relative claims unresolved but keeps absolute ones", () => {
	assert.deepEqual(claimed('cd "$DIR" && mkdir rel && mkdir /abs/ok'), ["/abs/ok"]);
	assert.deepEqual(claimed("cd - && mkdir rel"), []);
	assert.deepEqual(claimed("(cd /tmp && mkdir rel && mkdir /abs/ok)"), ["/abs/ok"]);
	assert.deepEqual(claimed("if cd /tmp; then mkdir rel; fi"), []);
	assert.deepEqual(claimed("pushd /tmp && mkdir rel"), []);
	assert.deepEqual(claimed("mkdir before || true; cd /tmp"), ["/work/before"]);
});

test("claims skip dynamic, globbed, brace-expanded, and unknown-option commands", () => {
	assert.deepEqual(claimed('mkdir -p "$BASE/a"'), []);
	assert.deepEqual(claimed("mkdir -p $(date +%F)"), []);
	assert.deepEqual(claimed("mkdir out-*"), []);
	assert.deepEqual(claimed("mkdir -p a/{b,c}"), []);
	assert.deepEqual(claimed("mkdir --bogus x"), []);
	assert.deepEqual(claimed("mkdir"), []);
	assert.deepEqual(claimed("env -C /elsewhere mkdir x"), []);
	assert.deepEqual(claimed("mkdir ~someone/x"), []);
});

test("git clone claims the explicit or default directory", () => {
	assert.deepEqual(claimed("git clone https://github.com/o/repo.git"), ["/work/repo"]);
	assert.deepEqual(claimed("git clone https://github.com/o/repo"), ["/work/repo"]);
	assert.deepEqual(claimed("git clone https://github.com/o/repo.git/"), ["/work/repo"]);
	assert.deepEqual(claimed("git clone git@github.com:o/repo.git"), ["/work/repo"]);
	assert.deepEqual(claimed("git clone ../local/src"), ["/work/src"]);
	assert.deepEqual(claimed("git clone --bare https://github.com/o/repo.git"), ["/work/repo.git"]);
	assert.deepEqual(claimed("git clone --mirror https://github.com/o/repo"), ["/work/repo.git"]);
	assert.deepEqual(
		claimed("git clone --depth 1 -b main -c core.x=1 --recurse-submodules https://x/o/r.git dest"),
		["/work/dest"],
	);
	assert.deepEqual(claimed("git -C /srv clone https://x/o/r.git"), ["/srv/r"]);
	assert.deepEqual(claimed("git -c http.proxy=p clone https://x/o/r.git"), ["/work/r"]);
	assert.deepEqual(claimed("git clone --totally-new-flag https://x/o/r.git"), []);
	assert.deepEqual(claimed("git clone"), []);
	assert.deepEqual(claimed("git clone a b c"), []);
	assert.deepEqual(claimed("git status"), []);
});

test("gh repo clone claims the explicit or default directory", () => {
	assert.deepEqual(claimed("gh repo clone mdarocha/robo-intern"), ["/work/robo-intern"]);
	assert.deepEqual(claimed("gh repo clone https://github.com/o/r.git"), ["/work/r"]);
	assert.deepEqual(claimed("gh repo clone o/r dest -- --depth=1"), ["/work/dest"]);
	assert.deepEqual(claimed("gh repo clone o/r -u up"), ["/work/r"]);
	assert.deepEqual(claimed("gh repo clone o/r -- --bare"), []);
	assert.deepEqual(claimed("gh repo view o/r"), []);
	assert.deepEqual(
		claimed("mkdir -p /tmp/bot-prs && cd /tmp/bot-prs && gh repo clone mdarocha/robo-intern"),
		["/tmp/bot-prs", "/tmp/bot-prs/robo-intern"],
	);
});

test("git worktree add claims its path, with options, -C, and a commit-ish", () => {
	assert.deepEqual(claimed("git worktree add -b feat /tmp/wt origin/main"), ["/tmp/wt"]);
	assert.deepEqual(claimed("git worktree add --detach ../wt HEAD~1", "/work/repo"), ["/work/wt"]);
	assert.deepEqual(claimed("git -C /repo worktree add ../wt2"), ["/wt2"]);
	assert.deepEqual(claimed("git worktree add -B br --reason why wt"), ["/work/wt"]);
	assert.deepEqual(claimed("git worktree remove /tmp/wt"), []);
	assert.deepEqual(claimed("git worktree add"), []);
});

test("wrappers that unwrap transparently still claim the creation", () => {
	assert.deepEqual(claimed("env FOO=1 mkdir x"), ["/work/x"]);
	assert.deepEqual(claimed("command git clone https://x/o/r.git"), ["/work/r"]);
	assert.deepEqual(claimed("bash -c 'mkdir /tmp/inner'"), ["/tmp/inner"]);
});

test("write claims a resolved file path and skips URL schemes", () => {
	assert.deepEqual(claimsFromWrite("/work", "notes/a.txt").paths, [{ path: "/work/notes/a.txt", createsParents: true }]);
	assert.deepEqual(claimsFromWrite("/work", "~/a.txt").paths, [{ path: `${HOME}/a.txt`, createsParents: true }]);
	assert.deepEqual(claimsFromWrite("/work", "local://plan.md").paths, []);
	assert.deepEqual(claimsFromWrite("/work", "").paths, []);
	assert.deepEqual(claimsFromWrite("/work", undefined).paths, []);
});

test("mktemp captures are recognised only for a single, creating, static mktemp", () => {
	const plain = claimsFromBash(analyzeBash("d=$(mktemp -d)"), WORK).mktemp;
	assert.ok(plain);
	assert.ok(plain.basename.test("tmp.AbCdEfGhIj"));
	assert.ok(!plain.basename.test("tmp.short"));
	assert.ok(!plain.basename.test("other.AbCdEfGhIj"));

	const templated = claimsFromBash(analyzeBash("mktemp -d /tmp/foo.XXXXXX --suffix=.log"), WORK).mktemp;
	assert.ok(templated);
	assert.ok(templated.basename.test("foo.a1B2c3.log"));
	assert.ok(!templated.basename.test("foo.a1B2c3"));

	assert.equal(claimsFromBash(analyzeBash("mktemp -u"), WORK).mktemp, undefined);
	assert.equal(claimsFromBash(analyzeBash("a=$(mktemp); b=$(mktemp)"), WORK).mktemp, undefined);
	assert.equal(claimsFromBash(analyzeBash('mktemp -d "$BASE/x.XXXX"'), WORK).mktemp, undefined);
	assert.equal(claimsFromBash(analyzeBash("mktemp -d bad"), WORK).mktemp, undefined);
	assert.equal(claimsFromBash(analyzeBash("mktemp --nope"), WORK).mktemp, undefined);
});

test("snapshot keeps the topmost missing ancestor for parent-creating claims", async () => {
	await withTempDir((base) => {
		mkdirSync(join(base, "exists"));
		const pending = snapshotCreations(
			claimsFromBash(
				analyzeBash(`mkdir -p ${base}/new/deep/er ${base}/exists ${base}/exists/child && mkdir ${base}/plain`),
				base,
			),
			Date.now(),
		);
		assert.deepEqual(pending?.paths, [join(base, "new"), join(base, "exists", "child"), join(base, "plain")]);
	});
});

test("snapshot without -p claims only the target, and skips paths that already exist", async () => {
	await withTempDir((base) => {
		mkdirSync(join(base, "there"));
		writeFileSync(join(base, "file"), "x");
		const nested = snapshotCreations(claimsFromBash(analyzeBash(`mkdir ${base}/missing/child`), base), Date.now());
		assert.deepEqual(nested?.paths, [join(base, "missing", "child")]);
		assert.equal(snapshotCreations(claimsFromBash(analyzeBash(`mkdir -p ${base}/there`), base), Date.now()), undefined);
		assert.equal(snapshotCreations(claimsFromWrite(base, join(base, "file")), Date.now()), undefined);
		assert.equal(snapshotCreations({ paths: [] }, Date.now()), undefined);
	});
});

test("snapshot treats a dangling symlink as existing", async () => {
	await withTempDir((base) => {
		symlinkSync(join(base, "nowhere"), join(base, "link"));
		assert.equal(snapshotCreations(claimsFromBash(analyzeBash(`mkdir -p ${base}/link`), base), Date.now()), undefined);
	});
});

test("confirm returns only claimed paths that exist after the call", async () => {
	await withTempDir((base) => {
		const pending = snapshotCreations(
			claimsFromBash(analyzeBash(`mkdir -p ${base}/made ${base}/never && mkdir ${base}/also`), base),
			Date.now(),
		);
		assert.ok(pending);
		mkdirSync(join(base, "made", "sub"), { recursive: true });
		mkdirSync(join(base, "also"));
		assert.deepEqual(confirmCreations(pending, ""), [join(base, "made"), join(base, "also")]);
	});
});

test("confirm recovers a single mktemp output line that is fresh and template-shaped", async () => {
	await withTempDir((base) => {
		const claims = claimsFromBash(analyzeBash("d=$(mktemp -d /tmp/foo.XXXXXX) && echo $d"), base);
		const startedAtMs = Date.now();
		const created = join(base, "foo.AbC123");
		mkdirSync(created);
		const pending = { paths: [], mktemp: claims.mktemp, startedAtMs };
		assert.deepEqual(confirmCreations(pending, `${created}\n`), [created]);
		assert.deepEqual(confirmCreations(pending, `note\n${created}\n`), []);
		assert.deepEqual(confirmCreations(pending, `${created}\n${created}\n`), []);
		assert.deepEqual(confirmCreations(pending, `${join(base, "bar.AbC123")}\n`), []);
		assert.deepEqual(confirmCreations(pending, ""), []);

		// A directory that predates the call has an older ctime than the call start.
		const preexisting = join(base, "foo.Old123");
		mkdirSync(preexisting);
		assert.deepEqual(confirmCreations({ ...pending, startedAtMs: Date.now() + 3_600_000 }, `${preexisting}\n`), []);
	});
});

test("confirm resolves a relative mktemp output against the recorded cwd only", async () => {
	await withTempDir((base) => {
		const claims = claimsFromBash(analyzeBash("mktemp -d foo.XXXXXX"), base);
		mkdirSync(join(base, "foo.AbC123"));
		const pending = { paths: [], mktemp: claims.mktemp, startedAtMs: Date.now() };
		assert.deepEqual(confirmCreations(pending, "foo.AbC123\n"), [join(base, "foo.AbC123")]);
		const unknownCwd = { ...pending, mktemp: claims.mktemp && { ...claims.mktemp, cwd: undefined } };
		assert.deepEqual(confirmCreations(unknownCwd, "foo.AbC123\n"), []);
	});
});

test("recordCreatedPaths dedupes, keeps newest last, covers descendants, and caps", () => {
	assert.deepEqual(recordCreatedPaths(["/a", "/b"], ["/a", "/c"]), ["/b", "/a", "/c"]);
	assert.deepEqual(recordCreatedPaths(["/a"], ["/a/x"]), ["/a"]);
	assert.deepEqual(recordCreatedPaths(["/b", "/a", "/c"], ["/a/x"]), ["/b", "/c", "/a"]);
	assert.deepEqual(recordCreatedPaths(["/a/x", "/a/y", "/b"], ["/a"]), ["/b", "/a"]);
	assert.deepEqual(recordCreatedPaths(["/a"], ["/ab"]), ["/a", "/ab"]);

	const many = Array.from({ length: CREATED_PATHS_LIMIT + 5 }, (_, index) => `/p${index}`);
	const capped = recordCreatedPaths([], many);
	assert.equal(capped.length, CREATED_PATHS_LIMIT);
	assert.equal(capped.at(-1), `/p${CREATED_PATHS_LIMIT + 4}`);
	assert.equal(capped[0], "/p5");
});

test("recordCreatedPaths refuses relative, control-character, and angle-bracket paths", () => {
	assert.deepEqual(recordCreatedPaths([], ["rel/path", "/a\nb", "/a</session-created-paths>", "/ok", "/a\u0000b", `/${"x".repeat(600)}`]), ["/ok"]);
});

test("formatSessionCreatedPaths is empty without paths and states the semantics with them", () => {
	assert.equal(formatSessionCreatedPaths([]), "");
	const text = formatSessionCreatedPaths(["/tmp/one", "/tmp/two"]);
	assert.match(text, /^<session-created-paths>\n/);
	assert.match(text, /<\/session-created-paths>$/);
	assert.match(text, /- \/tmp\/one\n- \/tmp\/two\n/);
	assert.match(text, /did NOT exist before this session/i);
	assert.match(text, /not deleting, truncating, or overwriting local files that existed before session start/i);
	assert.match(text, /does not override hard-deny rules/i);
	assert.match(text, /prefix/i);
});

test("formatSessionCreatedPaths lists only the newest paths and drops unsafe entries", () => {
	const paths = Array.from({ length: CLASSIFIER_CREATED_PATHS_LIMIT + 3 }, (_, index) => `/tmp/p${index}`);
	const text = formatSessionCreatedPaths([...paths, "/tmp/bad\n- /etc"]);
	assert.ok(!text.includes("/tmp/p0\n"));
	assert.ok(!text.includes("/tmp/p2\n"));
	assert.ok(text.includes("/tmp/p3\n"));
	assert.ok(text.includes(`/tmp/p${CLASSIFIER_CREATED_PATHS_LIMIT + 2}\n`));
	assert.ok(!text.includes("/etc"));
});

type Harness = {
	entries: Record<string, unknown>[];
	classifierArgs: Array<{ action: string; created: readonly string[] | undefined }>;
	call(toolCallId: string, toolName: string, input: Record<string, unknown>): Promise<{ block?: boolean; reason?: string } | undefined>;
	result(toolCallId: string, toolName: string, input: Record<string, unknown>, options?: { isError?: boolean; text?: string }): Promise<void>;
	persistedPaths(): string[] | undefined;
};

async function harnessFor(
	cwd: string,
	options: { config?: EffectiveConfig; decision?: "allow" | "block"; entries?: Record<string, unknown>[] } = {},
): Promise<Harness> {
	const fake = createFakePi();
	const classifierArgs: Harness["classifierArgs"] = [];
	const classify: ClassifyAction = async (_ctx, _config, action, _loaded, _notes, created) => {
		classifierArgs.push({ action, created });
		return { decision: options.decision ?? "allow", tier: "none", reason: "test" };
	};
	createPiAutomode({ loadConfig: () => options.config ?? baseConfig(), classifyAction: classify })(fake.pi);
	fake.entries.push(...(options.entries ?? []));
	const ctx = createFakeCtx(fake.entries, { cwd });
	await fake.emit("session_start", { type: "session_start" }, ctx);
	return {
		entries: fake.entries,
		classifierArgs,
		call: (toolCallId, toolName, input) =>
			fake.emit("tool_call", { type: "tool_call", toolCallId, toolName, input }, ctx) as Promise<
				{ block?: boolean; reason?: string } | undefined
			>,
		result: async (toolCallId, toolName, input, resultOptions = {}) => {
			await fake.emit("tool_result", {
				type: "tool_result",
				toolCallId,
				toolName,
				input,
				content: [{ type: "text", text: resultOptions.text ?? "" }],
				details: undefined,
				isError: resultOptions.isError ?? false,
			}, ctx);
		},
		persistedPaths: () => {
			const states = fake.entries.filter((entry) => entry.customType === STATE_ENTRY);
			return states.at(-1)?.data.createdPaths;
		},
	};
}

test("a successful allowed mkdir is persisted and handed to the next classifier call", async () => {
	await withTempDir(async (base) => {
		const harness = await harnessFor(base);
		const command = `mkdir -p ${base}/bot/work`;
		assert.equal(await harness.call("c1", "bash", { command }), undefined);
		mkdirSync(join(base, "bot", "work"), { recursive: true });
		await harness.result("c1", "bash", { command });
		assert.deepEqual(harness.persistedPaths(), [join(base, "bot")]);

		await harness.call("c2", "bash", { command: `rm -rf ${base}/bot` });
		assert.deepEqual(harness.classifierArgs.at(-1)?.created, [join(base, "bot")]);
	});
});

test("a failed call records nothing, even when it created the directory first", async () => {
	await withTempDir(async (base) => {
		const harness = await harnessFor(base);
		const command = `mkdir ${base}/half && false`;
		await harness.call("c1", "bash", { command });
		mkdirSync(join(base, "half"));
		await harness.result("c1", "bash", { command }, { isError: true });
		assert.deepEqual(harness.persistedPaths()?.filter(Boolean) ?? [], []);
		await harness.call("c2", "bash", { command: "echo next" });
		assert.deepEqual(harness.classifierArgs.at(-1)?.created, []);
	});
});

test("a blocked call records nothing even if a result event follows", async () => {
	await withTempDir(async (base) => {
		const harness = await harnessFor(base, { decision: "block" });
		const command = `mkdir ${base}/blocked`;
		const verdict = await harness.call("c1", "bash", { command });
		assert.equal(verdict?.block, true);
		mkdirSync(join(base, "blocked"));
		await harness.result("c1", "bash", { command }, { isError: true });
		await harness.result("c1", "bash", { command });
		assert.deepEqual(harness.persistedPaths() ?? [], []);
	});
});

test("a result for an unknown tool call id records nothing", async () => {
	await withTempDir(async (base) => {
		const harness = await harnessFor(base);
		mkdirSync(join(base, "stray"));
		await harness.result("never-called", "bash", { command: `mkdir ${base}/stray` });
		assert.deepEqual(harness.persistedPaths() ?? [], []);
	});
});

test("a path that already existed is not recorded as created by the session", async () => {
	await withTempDir(async (base) => {
		mkdirSync(join(base, "old"));
		const harness = await harnessFor(base);
		const command = `mkdir -p ${base}/old`;
		await harness.call("c1", "bash", { command });
		await harness.result("c1", "bash", { command });
		assert.deepEqual(harness.persistedPaths() ?? [], []);
	});
});

test("a new file written by the write tool is recorded, an overwrite is not", async () => {
	await withTempDir(async (base) => {
		writeFileSync(join(base, "old.txt"), "old");
		const harness = await harnessFor(base);
		const fresh = { path: "sub/new.txt", content: "x" };
		await harness.call("w1", "write", fresh);
		mkdirSync(join(base, "sub"));
		writeFileSync(join(base, "sub", "new.txt"), "x");
		await harness.result("w1", "write", fresh);
		assert.deepEqual(harness.persistedPaths(), [join(base, "sub")]);

		const overwrite = { path: "old.txt", content: "y" };
		await harness.call("w2", "write", overwrite);
		await harness.result("w2", "write", overwrite);
		assert.deepEqual(harness.persistedPaths(), [join(base, "sub")]);
	});
});

test("git clone, gh repo clone, and worktree creations are recorded after success", async () => {
	await withTempDir(async (base) => {
		const harness = await harnessFor(base);
		const command = `mkdir -p ${base}/bot-prs && cd ${base}/bot-prs && gh repo clone o/robo-intern && git worktree add ../bot-prs/robo-intern-main`;
		await harness.call("c1", "bash", { command });
		mkdirSync(join(base, "bot-prs", "robo-intern", ".git"), { recursive: true });
		mkdirSync(join(base, "bot-prs", "robo-intern-main"));
		await harness.result("c1", "bash", { command });
		assert.deepEqual(harness.persistedPaths(), [join(base, "bot-prs")]);
	});
});

test("a mktemp capture is recorded from the tool output", async () => {
	await withTempDir(async (base) => {
		const harness = await harnessFor(base);
		const command = `d=$(mktemp -d ${base}/scratch.XXXXXX) && echo "$d"`;
		await harness.call("c1", "bash", { command });
		const created = join(base, "scratch.Ab12Cd");
		mkdirSync(created);
		await harness.result("c1", "bash", { command }, { text: `${created}\n` });
		assert.deepEqual(harness.persistedPaths(), [created]);
	});
});

test("tracked paths survive restore, tolerate old entries, and respect the cap", () => {
	const old = createFakeCtx([{ type: "custom", customType: STATE_ENTRY, data: { checkedActions: 2 } }]);
	assert.deepEqual(restoreState(old as never).state.createdPaths, []);

	const saved = createFakeCtx([
		{ type: "custom", customType: STATE_ENTRY, data: { createdPaths: ["/tmp/a", 7, "rel", "/tmp/b"] } },
	]);
	assert.deepEqual(restoreState(saved as never).state.createdPaths, ["/tmp/a", "/tmp/b"]);

	const tooMany = Array.from({ length: CREATED_PATHS_LIMIT + 10 }, (_, index) => `/tmp/p${index}`);
	const capped = createFakeCtx([{ type: "custom", customType: STATE_ENTRY, data: { createdPaths: tooMany } }]);
	const restored = restoreState(capped as never).state.createdPaths;
	assert.equal(restored.length, CREATED_PATHS_LIMIT);
	assert.equal(restored.at(-1), tooMany.at(-1));

	const notArray = createFakeCtx([{ type: "custom", customType: STATE_ENTRY, data: { createdPaths: "/tmp/a" } }]);
	assert.deepEqual(restoreState(notArray as never).state.createdPaths, []);
});

test("a resumed session keeps the paths it created before", async () => {
	await withTempDir(async (base) => {
		const first = await harnessFor(base);
		const command = `mkdir ${base}/kept`;
		await first.call("c1", "bash", { command });
		mkdirSync(join(base, "kept"));
		await first.result("c1", "bash", { command });

		const resumed = await harnessFor(base, { entries: structuredClone(first.entries) });
		await resumed.call("c2", "bash", { command: `rm -r ${base}/kept` });
		assert.deepEqual(resumed.classifierArgs.at(-1)?.created, [join(base, "kept")]);
	});
});

test("tracking is inert while auto mode is off", async () => {
	await withTempDir(async (base) => {
		const harness = await harnessFor(base, { config: baseConfig({ enabled: false }) });
		const command = `mkdir ${base}/off`;
		await harness.call("c1", "bash", { command });
		mkdirSync(join(base, "off"));
		await harness.result("c1", "bash", { command });
		assert.deepEqual(harness.persistedPaths() ?? [], []);
	});
});

test("a tracked path never bypasses hard-deny or deniedPaths", async () => {
	await withTempDir(async (base) => {
		const harness = await harnessFor(base, { config: baseConfig({ deniedPaths: [`${base}/bot/secret/*`] }) });
		const command = `mkdir -p ${base}/bot/secret`;
		await harness.call("c1", "bash", { command });
		mkdirSync(join(base, "bot", "secret"), { recursive: true });
		await harness.result("c1", "bash", { command });
		assert.deepEqual(harness.persistedPaths(), [join(base, "bot")]);
		const classified = harness.classifierArgs.length;

		const hardDenied = await harness.call("c2", "bash", { command: `rm -rf ${base}/bot /` });
		assert.equal(hardDenied?.block, true);
		const pathDenied = await harness.call("c3", "write", { path: `${base}/bot/secret/key.txt`, content: "x" });
		assert.equal(pathDenied?.block, true);
		assert.match(pathDenied?.reason ?? "", /Path denied by policy/);
		assert.equal(harness.classifierArgs.length, classified);
	});
});

type CompletionContext = { messages: Array<{ content: Array<{ text: string }> }> };

function completionCapture() {
	const calls: CompletionContext[] = [];
	const model = { provider: "p", id: "m", api: "x", reasoning: false, contextWindow: 128_000, maxTokens: 4096 } as never;
	const ctx = createFakeCtx([], {
		model,
		modelRegistry: {
			find: () => model,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
			async complete(_model: unknown, context: CompletionContext) {
				calls.push(context);
				return { role: "assistant", content: [{ type: "text", text: "0" }], api: "x", provider: "p", model: "m", usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } }, stopReason: "stop", timestamp: Date.now() };
			},
		},
	});
	return { ctx, calls };
}

test("the classifier context lists created paths after the transcript, with the semantics", async () => {
	const { ctx, calls } = completionCapture();
	const result = await defaultClassifyAction(
		ctx as never,
		baseConfig(),
		'{"toolName":"bash","input":{"command":"rm -rf /tmp/bot-prs/robo-intern"}}',
		"",
		[],
		["/tmp/bot-prs"],
	);
	assert.equal(result.decision, "allow");
	const context: string = calls[0].messages[0].content[0].text;
	assert.match(context, /<\/classifier-transcript>\n\n<session-created-paths>\n/);
	assert.match(context, /- \/tmp\/bot-prs\n<\/session-created-paths>$/);
	assert.match(context, /does not override hard-deny rules/i);
	assert.equal(result.io?.prompt.context, context);
	assert.ok(!result.io?.prompt.system.includes("session-created-paths"));
});

test("the classifier context omits the block when nothing was created", async () => {
	const { ctx, calls } = completionCapture();
	await defaultClassifyAction(ctx as never, baseConfig(), '{"toolName":"bash","input":{"command":"ls"}}', "");
	await defaultClassifyAction(ctx as never, baseConfig(), '{"toolName":"bash","input":{"command":"ls"}}', "", [], []);
	for (const context of calls) {
		assert.ok(!context.messages[0].content[0].text.includes("session-created-paths"));
		assert.match(context.messages[0].content[0].text, /<\/classifier-transcript>$/);
	}
});
