import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	CLASSIFIER_SYSTEM_PROMPT,
	DEFAULT_ALLOW,
	DEFAULT_HARD_DENY,
	LOADED_EXTENSION_PATHS,
	PI_GLOBAL_SETTINGS,
	buildClassifierPrompt,
	createPiAutomode,
	defaultClassifyAction,
	describeActiveControls,
	deterministicHardDeny,
	isSafetyControlPath,
	type ActiveControls,
} from "../extensions/auto-mode.ts";
import {
	baseConfig,
	createFakeCtx,
	createFakePi,
	setupHookTest,
} from "./test-helpers.ts";

const LOADED_ENTRY = LOADED_EXTENSION_PATHS.find((path) => path.endsWith("/extensions/auto-mode.ts"))!;
const LOADED_DIR = LOADED_EXTENSION_PATHS.find((path) => path.endsWith("/extensions/auto-mode"))!;
const LOADED_VENDOR = LOADED_EXTENSION_PATHS.find((path) => path.endsWith("/extensions/vendor"))!;

/** A file the loaded extension would execute, for each loaded path. */
const LOADED_TARGETS = [
	LOADED_ENTRY,
	join(LOADED_DIR, "state.ts"),
	join(LOADED_DIR, "brand-new-module.ts"),
	join(LOADED_VENDOR, "unbash/dist/parser.js"),
];

const SAFETY_CONTROL = /safety-control/;

/** A scratch tree that holds a second checkout of the extension source. */
function withCheckouts(run: (base: string, checkouts: string[]) => void | Promise<void>) {
	const base = mkdtempSync(join(os.tmpdir(), "self-protection-"));
	return (async () => {
		try {
			const checkouts = ["omp-automode", "pi-automode"].map((name) => join(base, name));
			for (const root of checkouts) {
				mkdirSync(join(root, "extensions/auto-mode"), { recursive: true });
				mkdirSync(join(root, "extensions/vendor/unbash/dist"), { recursive: true });
				mkdirSync(join(root, "docs"), { recursive: true });
				for (const file of [
					"extensions/auto-mode.ts",
					"extensions/auto-mode/state.ts",
					"extensions/vendor/unbash/dist/parser.js",
					"docs/auto-mode.md",
					"README.md",
				]) {
					writeFileSync(join(root, file), "export {};\n");
				}
			}
			await run(base, checkouts);
		} finally {
			rmSync(base, { recursive: true, force: true });
		}
	})();
}

function withEnvPolicy<T>(value: string | undefined, run: () => T): T {
	const previous = process.env.PI_AUTOMODE_SETTINGS_JSON;
	if (value === undefined) delete process.env.PI_AUTOMODE_SETTINGS_JSON;
	else process.env.PI_AUTOMODE_SETTINGS_JSON = value;
	try {
		return run();
	} finally {
		if (previous === undefined) delete process.env.PI_AUTOMODE_SETTINGS_JSON;
		else process.env.PI_AUTOMODE_SETTINGS_JSON = previous;
	}
}

function assistantText(text: string) {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason: "stop",
		timestamp: Date.now(),
	};
}

test("the loaded extension paths are real paths of this copy of the source", () => {
	assert.ok(statSync(LOADED_ENTRY).isFile());
	assert.ok(statSync(LOADED_DIR).isDirectory());
	assert.ok(statSync(LOADED_VENDOR).isDirectory());
	assert.equal(LOADED_EXTENSION_PATHS.length, 3);
});

test("the classifier prompt lists the active controls", () => {
	const controls = withEnvPolicy("{}", () =>
		describeActiveControls("/work/proj", ["/home/u/.pi/agent/extensions/pi-automode/config.json"]));
	const prompt = buildClassifierPrompt(baseConfig(), controls);

	for (const path of LOADED_EXTENSION_PATHS) assert.ok(prompt.includes(path), path);
	for (const path of [
		"/home/u/.pi/agent/extensions/pi-automode/config.json",
		"/work/proj/.pi/automode.local.json",
		"/work/proj/.pi/automode.json",
	]) {
		assert.ok(prompt.includes(path), path);
	}
	assert.match(prompt, /PI_AUTOMODE_SETTINGS_JSON is set for this process/);
	assert.doesNotMatch(prompt, /<ACTIVE_CONTROLS>/);

	const withoutPolicy = withEnvPolicy(undefined, () =>
		buildClassifierPrompt(baseConfig(), describeActiveControls("/work/proj")));
	assert.match(withoutPolicy, /PI_AUTOMODE_SETTINGS_JSON is not set/);
	assert.ok(withoutPolicy.includes(PI_GLOBAL_SETTINGS[0]!));
});

test("the prompt keeps the self-protection scope when users replace hard_deny", () => {
	const prompt = buildClassifierPrompt(
		baseConfig({ hardDeny: ["Custom rule about the agent's safety controls."] }),
		describeActiveControls("/work/proj"),
	);
	assert.match(prompt, /Self-protection covers exactly the Active controls above/);
	assert.match(prompt, /git clones, worktrees, other checkouts[^\n]*ordinary project code/);
	assert.match(prompt, /HARD_DENY self-protection does not apply to them/);
});

test("prompt sections are expanded in one pass", () => {
	const controls: ActiveControls = {
		extensionPaths: ["/ext/$&/auto-mode.ts"],
		globalConfigPaths: [],
		projectConfigPaths: [],
		envPolicy: false,
		cwd: "/work/<ALLOW_RULES>",
	};
	const prompt = buildClassifierPrompt(
		baseConfig({ environment: ["mentions <HARD_DENY_RULES> and $& literally"], allow: ["A rule."] }),
		controls,
	);
	assert.ok(prompt.includes("mentions <HARD_DENY_RULES> and $& literally"));
	assert.ok(prompt.includes("/ext/$&/auto-mode.ts"));
	assert.ok(prompt.includes("/work/<ALLOW_RULES>"));
	assert.equal(prompt.split("A rule.").length - 1, 1);
});

test("default classifier sends the active controls of the call's working directory", async () => {
	const model = { provider: "test", id: "runtime-model", api: "runtime-only-api", reasoning: false, contextWindow: 128_000, maxTokens: 4096 };
	const prompts: string[] = [];
	const ctx = createFakeCtx([], {
		cwd: "/work/proj",
		model,
		modelRegistry: {
			find: () => model,
			getApiKeyAndHeaders: async () => ({ ok: true, apiKey: "key" }),
			async complete(_model: unknown, context: { systemPrompt: string }) {
				prompts.push(context.systemPrompt);
				return assistantText("0");
			},
		},
	});
	const action = '{"toolName":"bash","input":{"command":"echo ok"}}';

	await defaultClassifyAction(ctx as never, baseConfig(), action, "");
	await defaultClassifyAction(
		ctx as never,
		baseConfig(),
		action,
		"",
		[],
		[],
		undefined,
		describeActiveControls("/work/proj", ["/custom/automode/config.json"]),
	);

	assert.ok(prompts[0]!.includes("/work/proj/.pi/automode.local.json"));
	assert.ok(prompts[0]!.includes(LOADED_DIR));
	assert.ok(prompts[1]!.includes("/custom/automode/config.json"));
});

test("the hook gives the classifier the active controls for the call", async () => {
	const fake = createFakePi();
	const seen: Array<ActiveControls | undefined> = [];
	createPiAutomode({
		loadConfig: () => baseConfig(),
		prepareGlobalConfig: () => ({ status: "current", activePath: "/custom/automode/config.json" }),
		classifyAction: async (_ctx, _config, _action, _loaded, _notes, _created, _hints, controls) => {
			seen.push(controls);
			return { decision: "allow", tier: "none", reason: "ok" };
		},
	})(fake.pi);
	const ctx = createFakeCtx(fake.entries, { cwd: "/work/proj" });
	await fake.emit("session_start", { type: "session_start" }, ctx);

	await fake.emit("tool_call", { toolName: "bash", input: { command: "echo hi" } }, ctx);

	assert.equal(seen.length, 1);
	assert.deepEqual(seen[0]?.globalConfigPaths, ["/custom/automode/config.json"]);
	assert.equal(seen[0]?.cwd, "/work/proj");
	assert.deepEqual(seen[0]?.projectConfigPaths, [
		"/work/proj/.omp/automode.local.json",
		"/work/proj/.omp/automode.json",
		"/work/proj/.pi/automode.local.json",
		"/work/proj/.pi/automode.json",
	]);
	assert.deepEqual(seen[0]?.extensionPaths, [...LOADED_EXTENSION_PATHS]);
});

test("the default self-protection rule targets the active controls", () => {
	const rule = DEFAULT_HARD_DENY.find((entry) => entry.startsWith("Tampering with"));
	assert.ok(rule);
	assert.match(rule, /Active controls/);
	assert.match(rule, /loaded extension directory/);
	assert.match(rule, /PI_AUTOMODE_SETTINGS_JSON/);
	assert.match(rule, /git clone or worktree/);
	assert.doesNotMatch(rule, /files that define the agent's safety controls/);

	assert.doesNotMatch(CLASSIFIER_SYSTEM_PROMPT, /Modifying \.pi\/automode\*, this extension, or permission rules => block/);
	assert.match(CLASSIFIER_SYSTEM_PROMPT, /Modifying a path listed under Active controls/);
	assert.match(CLASSIFIER_SYSTEM_PROMPT, /state\.ts in a git clone or worktree that is not listed under Active controls/);
	assert.ok(DEFAULT_ALLOW.some((entry) =>
		entry.includes("Developing this extension's own source") && entry.includes("not listed under Active controls")));
});

test("a source checkout outside the loaded directory is not safety-control protected", async () => {
	await withCheckouts((base, checkouts) => {
		for (const root of checkouts) {
			for (const cwd of [root, base, "/tmp/project"]) {
				for (const file of [
					"extensions/auto-mode/state.ts",
					"extensions/auto-mode/brand-new.ts",
					"extensions/auto-mode.ts",
					"extensions/vendor/unbash/dist/parser.js",
					"docs/auto-mode.md",
					"README.md",
				]) {
					const path = join(root, file);
					assert.equal(isSafetyControlPath(path, cwd), false, `${path} (cwd ${cwd})`);
					for (const toolName of ["write", "edit"]) {
						assert.equal(deterministicHardDeny(toolName, { path }, cwd), undefined, `${toolName} ${path} (cwd ${cwd})`);
					}
				}
				const target = join(root, "extensions/auto-mode/state.ts");
				for (const command of [
					`echo x > ${target}`,
					`sed -i 's/a/b/' ${target}`,
					`cp ${join(root, "README.md")} ${target}`,
					`mv ${join(root, "README.md")} ${target}`,
					`tee ${target}`,
					`python3 -c "open('${target}','w').write('x')"`,
					`cd ${root} && sed -i 's/a/b/' extensions/auto-mode/state.ts`,
				]) {
					assert.equal(deterministicHardDeny("bash", { command }, cwd), undefined, `${command} (cwd ${cwd})`);
				}
			}
		}
		assert.equal(
			deterministicHardDeny("bash", { command: `rm -rf ${join(base, "pi-automode-scratch")}` }, base),
			undefined,
		);
	});
});

test("omp edit payloads against a source checkout are not safety-control protected", async () => {
	await withCheckouts((_base, [checkout]) => {
		const target = join(checkout!, "extensions/auto-mode/state.ts");
		const readme = join(checkout!, "README.md");
		const inputs: Array<Record<string, unknown>> = [
			{ path: target, input: `[${target}#AB12]\nPUT 1:\n+// note\n` },
			{ paths: [target, readme], input: `[${target}#AB12]\n[${readme}#CD34]\n` },
			{ input: `*** Begin Patch\n*** Update File: ${target}\n@@\n-a\n+b\n*** End Patch\n` },
			{ path: readme, input: `[${readme}#CD34]\nMV ${target}\n` },
		];
		for (const input of inputs) {
			assert.equal(deterministicHardDeny("edit", input, checkout!), undefined, JSON.stringify(input));
		}
	});
});

test("the loaded extension is hard-denied for write and edit", async () => {
	await withCheckouts((base) => {
		for (const cwd of [base, LOADED_DIR, "/tmp/project"]) {
			for (const path of LOADED_TARGETS) {
				for (const toolName of ["write", "edit"]) {
					assert.match(
						deterministicHardDeny(toolName, { path }, cwd) ?? "",
						SAFETY_CONTROL,
						`${toolName} ${path} (cwd ${cwd})`,
					);
				}
			}
		}
	});
});

test("the loaded extension is hard-denied through every omp edit payload shape", async () => {
	await withCheckouts((_base, [checkout]) => {
		const innocent = join(checkout!, "README.md");
		const target = join(LOADED_DIR, "state.ts");
		const inputs: Array<Record<string, unknown>> = [
			{ paths: [innocent, target], input: `[${innocent}#AB12]\n[${target}#CD34]\n` },
			{ input: `*** Begin Patch\n*** Update File: ${innocent}\n*** Add File: ${target}\n+x\n*** End Patch\n` },
			{ input: `*** Begin Patch\n*** Update File: ${innocent}\n*** Move to: ${target}\n*** End Patch\n` },
			{ input: `*** Begin Patch\n*** Delete File: ${target}\n*** End Patch\n` },
			{ path: innocent, input: `[${innocent}#AB12]\nMV ${target}\n` },
			{ path: innocent, input: `[${innocent}#AB12]\nMV "${target}"\n` },
		];
		for (const input of inputs) {
			assert.match(deterministicHardDeny("edit", input, checkout!) ?? "", SAFETY_CONTROL, JSON.stringify(input));
		}
	});
});

test("the loaded extension is hard-denied through a symlink", async () => {
	await withCheckouts((base) => {
		const link = join(base, "linked-source");
		symlinkSync(LOADED_DIR, link);
		assert.match(
			deterministicHardDeny("write", { path: join(link, "state.ts") }, base) ?? "",
			SAFETY_CONTROL,
		);
	});
});

test("the loaded extension is hard-denied for obvious Bash writes", () => {
	const target = join(LOADED_DIR, "state.ts");
	for (const command of [
		`echo x > ${target}`,
		`echo x >> ${LOADED_ENTRY}`,
		`sed -i 's/a/b/' ${target}`,
		`tee ${target}`,
		`cp /tmp/replacement.ts ${target}`,
		`mv /tmp/replacement.ts ${target}`,
		`rm ${target}`,
		`cd ${LOADED_DIR} && sed -i 's/a/b/' state.ts`,
		`python3 -c "open('${target}','w').write('x')"`,
		`node -e "require('fs').writeFileSync('${LOADED_ENTRY}','')"`,
	]) {
		assert.match(
			deterministicHardDeny("bash", { command }, "/tmp/project") ?? "",
			SAFETY_CONTROL,
			command,
		);
	}
});

test("every control listed in the prompt is deterministically protected", async () => {
	await withCheckouts((base) => {
		const controls = describeActiveControls(base);
		const files = [
			...controls.extensionPaths.map((path) => statSync(path).isDirectory() ? join(path, "new-file.ts") : path),
			...controls.globalConfigPaths,
			...controls.projectConfigPaths,
		];
		assert.ok(files.length >= 6);
		for (const path of files) {
			assert.match(deterministicHardDeny("write", { path }, base) ?? "", SAFETY_CONTROL, path);
		}
	});
});

test("install-directory and legacy config names stay protected", () => {
	const project = "/tmp/project";
	for (const path of [
		"/home/u/.omp/agent/extensions/pi-automode/config.json",
		"/home/u/.pi/agent/extensions/pi-automode/extensions/auto-mode.ts",
		"/tmp/project/auto-mode.json",
		"/tmp/project/auto-mode.local.json",
		"/tmp/project/.pi/automode.local.json",
	]) {
		assert.equal(isSafetyControlPath(path, project), true, path);
	}
});

test("the hook routes source checkout edits to the classifier and blocks the loaded copy", async () => {
	await withCheckouts(async (_base, [checkout]) => {
		const harness = await setupHookTest({
			config: baseConfig(),
			ctx: createFakeCtx([], { cwd: checkout }),
		});
		const checkoutResult = await harness.emit("tool_call", {
			toolName: "edit",
			input: { path: join(checkout!, "extensions/auto-mode/state.ts") },
		}, harness.ctx);
		assert.equal(checkoutResult, undefined);
		assert.equal(harness.classifierCalls, 1);

		const loadedResult = await harness.emit("tool_call", {
			toolName: "edit",
			input: { path: join(LOADED_DIR, "state.ts") },
		}, harness.ctx) as { block?: boolean; reason?: string };
		assert.equal(loadedResult.block, true);
		assert.match(loadedResult.reason ?? "", SAFETY_CONTROL);
		assert.equal(harness.classifierCalls, 1);
	});
});
