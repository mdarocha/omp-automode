import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Api, Model } from "@earendil-works/pi-ai";
import {
	createPiAutomode,
	PI_PROJECT_LOCAL_SETTINGS,
	setOmpBridgeForTesting,
	type EffectiveConfig,
	type OmpBridge,
	type PiAutomodeOptions,
	type SettingsFile,
	type SettingUpdate,
} from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, createFakePi, withEnv, withInline, withTempDir } from "./test-helpers.ts";

const MENU_TITLE = "pi-automode settings";
const BROWSE_OPTION = "Browse all models…";
const BLOCKED_REASON = "global config writes are disabled until interrupted migration cleanup finishes";
const CLASSIFIER_MODEL = { provider: "test", id: "classifier" };

function omModel(provider: string, id: string): Model<Api> {
	// Only provider and id are read when listing roles.
	return { provider, id } as unknown as Model<Api>;
}

const HAIKU = omModel("anthropic", "claude-haiku-5-5");
const SONNET = omModel("anthropic", "claude-sonnet-5-5");

type FakeBridge = OmpBridge & { pickCalls: Array<string | undefined> };

function fakeBridge(options: {
	chains?: Record<string, Model<Api>[]>;
	roles?: string[];
	picked?: string | Error;
} = {}): FakeBridge {
	const chains = options.chains ?? {};
	const pickCalls: Array<string | undefined> = [];
	return {
		pickCalls,
		roleNames: () => options.roles ?? Object.keys(chains),
		roleChain: (role) => chains[role] ?? [],
		async pickModel(_ctx, current) {
			pickCalls.push(current);
			if (options.picked instanceof Error) {
				throw options.picked;
			}
			return options.picked;
		},
		async judge() {
			throw new Error("the settings menu never calls the judge");
		},
	};
}

function fakeRegistry(auth: { ok: true } | { ok: false; error: string } = { ok: true }) {
	return {
		find: (provider: string, id: string) =>
			provider === CLASSIFIER_MODEL.provider && id === CLASSIFIER_MODEL.id ? CLASSIFIER_MODEL : undefined,
		getAvailable: () => [CLASSIFIER_MODEL],
		async getApiKeyAndHeaders() {
			return auth.ok ? { ok: true, apiKey: "test-key" } : auth;
		},
	};
}

function applyUpdate(config: EffectiveConfig, update: SettingUpdate): EffectiveConfig {
	switch (update.key) {
		case "enabled":
			return { ...config, enabled: update.value };
		case "classifierStrategy":
			return { ...config, classifierStrategy: update.value };
		case "classifierModel":
			return { ...config, classifierModel: update.value };
		case "judgeConfidence":
			return { ...config, judgeConfidence: update.value };
		case "classifierReasoningLevel":
			return { ...config, classifierReasoningLevel: update.value };
		case "log.enabled":
			return { ...config, log: { ...config.log, enabled: update.value } };
		case "log.classifierIo":
			return { ...config, log: { ...config.log, classifierIo: update.value } };
	}
}

/** Config and writer seams that keep saved updates in memory and feed them back into the loaded config. */
function memoryStore(saved: SettingUpdate[], initial: Partial<EffectiveConfig> = {}): PiAutomodeOptions {
	return {
		loadConfig: () => saved.reduce(applyUpdate, baseConfig(initial)),
		saveSetting: (update) => {
			saved.push(update);
		},
	};
}

type HarnessOptions = {
	/** Answers for `ui.select`: each picks the first option that starts with the text; undefined dismisses. */
	answers?: Array<string | undefined>;
	/** Answers for `ui.input`. */
	inputs?: Array<string | undefined>;
	/** Result of the Pi model list (`ui.custom`). */
	customResult?: string;
	hasUI?: boolean;
	cwd?: string;
	auth?: { ok: true } | { ok: false; error: string };
};

async function createHarness(automode: PiAutomodeOptions, options: HarnessOptions = {}) {
	const fake = createFakePi();
	createPiAutomode(automode)(fake.pi);
	const ctx = createFakeCtx(fake.entries, {
		hasUI: options.hasUI ?? true,
		modelRegistry: fakeRegistry(options.auth),
		...(options.cwd ? { cwd: options.cwd } : {}),
	});
	const answers = [...(options.answers ?? [])];
	const inputs = [...(options.inputs ?? [])];
	const selectCalls: Array<{ title: string; options: string[] }> = [];
	const inputCalls: Array<{ title: string; placeholder?: string }> = [];
	let customCalls = 0;
	Object.assign(ctx.ui, {
		async select(title: string, choices: string[]) {
			assert.ok(options.hasUI ?? true, "select must not run without a UI");
			selectCalls.push({ title, options: choices });
			const answer = answers.shift();
			if (answer === undefined) {
				return undefined;
			}
			const match = choices.find((choice) => choice.startsWith(answer));
			assert.ok(match, `no option starts with "${answer}" in: ${choices.join(" | ")}`);
			return match;
		},
		async input(title: string, placeholder?: string) {
			inputCalls.push({ title, placeholder });
			return inputs.shift();
		},
		async custom() {
			customCalls += 1;
			return options.customResult;
		},
	});
	await fake.emit("session_start", { type: "session_start" }, ctx);
	return {
		fake,
		ctx,
		selectCalls,
		inputCalls,
		get customCalls() {
			return customCalls;
		},
		/** Rows of the most recent settings menu, without the Done entry. */
		lastMenu(): string[] {
			const menus = selectCalls.filter((call) => call.title.startsWith(MENU_TITLE));
			return menus.at(-1)?.options.slice(0, -1) ?? [];
		},
		lastNotification() {
			return ctx.notifications.at(-1);
		},
		async run(args: string, bridge?: OmpBridge) {
			setOmpBridgeForTesting(bridge);
			try {
				await fake.commands.get("automode")!.handler(args, ctx);
			} finally {
				setOmpBridgeForTesting(undefined);
			}
		},
	};
}

function readSaved(path: string): SettingsFile {
	return JSON.parse(readFileSync(path, "utf8")) as SettingsFile;
}

test("the settings menu saves every setting through the writer", async () => {
	const saved: SettingUpdate[] = [];
	const h = await createHarness(memoryStore(saved), {
		answers: [
			"Enabled", "off",
			"Classifier strategy", "hybrid",
			"Judge confidence",
			"Classifier reasoning level", "high",
			"Decision log", "on",
			"Classifier I/O log", "on",
		],
		inputs: ["0.8"],
	});

	await h.run("settings");

	assert.deepEqual(saved, [
		{ key: "enabled", value: false },
		{ key: "classifierStrategy", value: "hybrid" },
		{ key: "judgeConfidence", value: 0.8 },
		{ key: "classifierReasoningLevel", value: "high" },
		{ key: "log.enabled", value: true },
		{ key: "log.classifierIo", value: true },
	]);
	assert.deepEqual(h.lastMenu(), [
		"Enabled: off",
		"Classifier strategy: hybrid",
		"Classifier model: current session model",
		"Judge confidence: 0.8",
		"Classifier reasoning level: high",
		"Decision log: on",
		"Classifier I/O log: on",
	]);
	assert.equal(h.ctx.notifications.some(({ message }) => message.includes("but the current config uses")), false);
	assert.match(h.ctx.notifications[0]!.message, /enabled saved globally: off/);
});

test("the settings menu marks the current choice and can unset the reasoning level", async () => {
	const strategySaved: SettingUpdate[] = [];
	const strategy = await createHarness(memoryStore(strategySaved, { classifierStrategy: "detailed" }), {
		answers: ["Classifier strategy", undefined],
	});
	await strategy.run("settings");
	const strategyChoices = strategy.selectCalls.find((call) => call.title === "Set classifier strategy")!.options;
	assert.equal(strategyChoices.length, 3);
	assert.match(strategyChoices[0]!, /^staged: /);
	assert.match(strategyChoices[1]!, /^detailed: .*\(current\)$/);
	assert.match(strategyChoices[2]!, /^hybrid: /);
	assert.deepEqual(strategySaved, []);

	const levelSaved: SettingUpdate[] = [];
	const levels = await createHarness(memoryStore(levelSaved, { classifierReasoningLevel: "high" }), {
		answers: ["Classifier reasoning level", "unset"],
	});
	await levels.run("settings");
	assert.deepEqual(levelSaved, [{ key: "classifierReasoningLevel", value: undefined }]);
	const levelChoices = levels.selectCalls.find((call) => call.title === "Set classifier reasoning level")!.options;
	assert.deepEqual(levelChoices.map((choice) => choice.replace(/:.*/, "")), ["unset", "low", "medium", "high (current)", "xhigh", "max"]);
});

test("the judge confidence prompt rejects values outside (0.5, 1] and ignores an empty answer", async () => {
	const saved: SettingUpdate[] = [];
	const h = await createHarness(memoryStore(saved), {
		answers: ["Judge confidence", "Judge confidence", "Judge confidence", "Judge confidence", "Judge confidence"],
		inputs: ["0.5", "1.2", "high", "  ", "1"],
	});

	await h.run("settings");

	assert.deepEqual(saved, [{ key: "judgeConfidence", value: 1 }]);
	const errors = h.ctx.notifications.filter(({ type }) => type === "error").map(({ message }) => message);
	assert.deepEqual(errors, [
		'Judge confidence must be a number above 0.5 and at most 1, not "0.5"',
		'Judge confidence must be a number above 0.5 and at most 1, not "1.2"',
		'Judge confidence must be a number above 0.5 and at most 1, not "high"',
	]);
	assert.equal(h.inputCalls[0]!.placeholder, "0.9");
});

test("a blocked global config refuses settings changes and says why", async () => {
	const saved: SettingUpdate[] = [];
	const h = await createHarness({
		...memoryStore(saved),
		prepareGlobalConfig: () => ({
			status: "failed",
			activePath: "/tmp/unused-config.json",
			writeBlockedReason: BLOCKED_REASON,
		}),
	}, { answers: ["Enabled", "off", "Classifier strategy", "hybrid"] });

	await h.run("settings");

	assert.deepEqual(saved, []);
	const errors = h.ctx.notifications.filter(({ type }) => type === "error");
	assert.equal(errors.length, 2);
	assert.equal(errors[0]!.message, `Failed to save enabled: ${BLOCKED_REASON}`);
	assert.equal(errors[1]!.message, `Failed to save classifier strategy: ${BLOCKED_REASON}`);
	assert.deepEqual(h.lastMenu().slice(0, 2), ["Enabled: on", "Classifier strategy: staged"]);
});

test("the settings menu shows where each effective value comes from", async () => {
	await withTempDir((dir) => withInline({ autoMode: { log: { enabled: true } } }, async () => {
		const globalPath = join(dir, "global.json");
		const localPath = join(dir, PI_PROJECT_LOCAL_SETTINGS[0]!);
		mkdirSync(join(localPath, ".."), { recursive: true });
		writeFileSync(globalPath, JSON.stringify({ autoMode: { classifierStrategy: "detailed" } }));
		writeFileSync(localPath, JSON.stringify({ autoMode: { judgeConfidence: 0.8 } }));
		const h = await createHarness({
			prepareGlobalConfig: () => ({ status: "current", activePath: globalPath }),
		}, { cwd: dir });

		await h.run("settings");

		assert.equal(h.selectCalls[0]!.title, `${MENU_TITLE} (saved to ${globalPath})`);
		assert.deepEqual(h.lastMenu(), [
			"Enabled: on [default]",
			"Classifier strategy: detailed [global file]",
			"Classifier model: current session model [default]",
			"Judge confidence: 0.8 [project-local file]",
			"Classifier reasoning level: unset (provider default) [default]",
			"Decision log: on [PI_AUTOMODE_SETTINGS_JSON]",
			"Classifier I/O log: off [default]",
		]);
	}));
});

test("the session override of /automode off is shown as the source of enabled", async () => {
	await withTempDir((dir) => withInline(undefined, async () => {
		const globalPath = join(dir, "global.json");
		const h = await createHarness({
			prepareGlobalConfig: () => ({ status: "current", activePath: globalPath }),
		}, { cwd: dir, answers: ["Enabled", "on"] });

		await h.run("off");
		await h.run("settings");

		assert.equal(h.selectCalls[0]!.options[0], "Enabled: off [this session (/automode on|off)]");
		assert.deepEqual(readSaved(globalPath), { autoMode: { enabled: true } });
		assert.deepEqual(h.lastNotification(), {
			message: "pi-automode enabled saved globally: on, but the current config uses off from this session (/automode on|off)",
			type: "warning",
		});
	}));
});

test("saving a setting that PI_AUTOMODE_SETTINGS_JSON overrides says which source wins", async () => {
	await withTempDir((dir) => withInline({ autoMode: { classifierStrategy: "hybrid" } }, async () => {
		const globalPath = join(dir, "global.json");
		const h = await createHarness({
			prepareGlobalConfig: () => ({ status: "current", activePath: globalPath }),
		}, { cwd: dir, answers: ["Classifier strategy", "detailed"] });

		await h.run("settings");

		assert.deepEqual(readSaved(globalPath), { autoMode: { classifierStrategy: "detailed" } });
		assert.deepEqual(h.lastNotification(), {
			message: "pi-automode classifier strategy saved globally: detailed, but the current config uses hybrid from PI_AUTOMODE_SETTINGS_JSON",
			type: "warning",
		});
		assert.equal(h.lastMenu()[1], "Classifier strategy: hybrid [PI_AUTOMODE_SETTINGS_JSON]");
	}));
});

test("saving a setting that the project-local file overrides names that file", async () => {
	await withTempDir((dir) => withInline(undefined, async () => {
		const globalPath = join(dir, "global.json");
		const localPath = join(dir, PI_PROJECT_LOCAL_SETTINGS[0]!);
		mkdirSync(join(localPath, ".."), { recursive: true });
		writeFileSync(localPath, JSON.stringify({ autoMode: { judgeConfidence: 0.7 } }));
		const h = await createHarness({
			prepareGlobalConfig: () => ({ status: "current", activePath: globalPath }),
		}, { cwd: dir, answers: ["Judge confidence"], inputs: ["0.95"] });

		await h.run("settings");

		assert.deepEqual(readSaved(globalPath), { autoMode: { judgeConfidence: 0.95 } });
		assert.deepEqual(h.lastNotification(), {
			message: `pi-automode judge confidence saved globally: 0.95, but the current config uses 0.7 from project-local file ${localPath}`,
			type: "warning",
		});
	}));
});

test("saving a setting nothing overrides reports plain success and keeps unrelated keys", async () => {
	await withTempDir((dir) => withInline(undefined, async () => {
		const globalPath = join(dir, "global.json");
		writeFileSync(globalPath, JSON.stringify({ permissions: { deny: ["bash(rm *)"] }, autoMode: { allow: ["$defaults"] } }));
		const h = await createHarness({
			prepareGlobalConfig: () => ({ status: "current", activePath: globalPath }),
		}, { cwd: dir, answers: ["Decision log", "on"] });

		await h.run("settings");

		assert.deepEqual(readSaved(globalPath), {
			permissions: { deny: ["bash(rm *)"] },
			autoMode: { allow: ["$defaults"], log: { enabled: true } },
		});
		assert.deepEqual(h.lastNotification(), {
			message: "pi-automode decision log saved globally: on",
			type: "info",
		});
		assert.equal(h.lastMenu()[5], "Decision log: on [global file]");
	}));
});

test("under OMP the menu shows the resolved classifier and a judge-model note", async () => {
	const saved: SettingUpdate[] = [];
	const bridge = fakeBridge({ chains: { smol: [HAIKU] } });
	const h = await createHarness(memoryStore(saved), { answers: ["Judge model"] });

	await h.run("settings", bridge);

	assert.deepEqual(h.selectCalls[0]!.options, [
		"Enabled: on",
		"Classifier strategy: staged",
		"Classifier model: @smol (default) → anthropic/claude-haiku-5-5",
		"Judge confidence: 0.9",
		"Judge model: set in OMP (model role judge), not here",
		"Classifier reasoning level: unset (provider default)",
		"Decision log: off",
		"Classifier I/O log: off",
		"Done",
	]);
	assert.deepEqual(saved, []);
	const note = h.ctx.notifications.at(-1)!;
	assert.equal(note.type, "info");
	assert.match(note.message, /no judge model setting/);
	assert.match(note.message, /modelRoles\.judge/);
});

test("the menu offers OMP roles and saves a role chosen for the classifier", async () => {
	const saved: SettingUpdate[] = [];
	const bridge = fakeBridge({
		chains: { smol: [HAIKU], judge: [SONNET], default: [] },
		roles: ["default", "smol", "judge"],
	});
	const h = await createHarness(memoryStore(saved), { answers: ["Classifier model", "@judge"] });

	await withEnv("TYPESAFE_API_KEY", undefined, () => h.run("settings", bridge));

	const prompt = h.selectCalls.find((call) => call.title.startsWith("Classifier model ("))!;
	assert.equal(prompt.title, "Classifier model (now @smol)");
	assert.deepEqual(prompt.options, [
		"@smol → anthropic/claude-haiku-5-5 (current)",
		"@judge → anthropic/claude-sonnet-5-5",
		BROWSE_OPTION,
	]);
	assert.deepEqual(saved, [{ key: "classifierModel", value: "@judge" }]);
	assert.equal(bridge.pickCalls.length, 0);
});

test("/automode model without arguments offers roles, then OMP's native picker for a model", async () => {
	const saved: SettingUpdate[] = [];
	const bridge = fakeBridge({ chains: { smol: [HAIKU] }, picked: "test/classifier" });
	const h = await createHarness(memoryStore(saved, { classifierModel: "test/classifier" }), { answers: [BROWSE_OPTION] });

	await h.run("model", bridge);

	assert.deepEqual(bridge.pickCalls, ["test/classifier"]);
	assert.deepEqual(saved, [{ key: "classifierModel", value: "test/classifier" }]);
	assert.equal(h.customCalls, 0);
	assert.match(h.lastNotification()!.message, /classifier model saved globally: test\/classifier/);
});

test("the native picker gets no preselection while the classifier is a role", async () => {
	const bridge = fakeBridge({ chains: { smol: [HAIKU] }, picked: undefined });
	const h = await createHarness(memoryStore([]), { answers: [BROWSE_OPTION] });

	await h.run("model", bridge);

	assert.deepEqual(bridge.pickCalls, [undefined]);
	assert.deepEqual(h.lastNotification(), { message: "Classifier model unchanged", type: "info" });
});

test("a model chosen in the native picker is validated like the argument form", async () => {
	const saved: SettingUpdate[] = [];
	const missing = await createHarness(memoryStore(saved), { answers: [BROWSE_OPTION] });
	await missing.run("model", fakeBridge({ chains: { smol: [HAIKU] }, picked: "other/missing" }));
	assert.deepEqual(missing.lastNotification(), { message: "Model not found: other/missing", type: "error" });

	const noAuth = await createHarness(memoryStore(saved), {
		answers: [BROWSE_OPTION],
		auth: { ok: false, error: "No API key for test" },
	});
	await noAuth.run("model", fakeBridge({ chains: { smol: [HAIKU] }, picked: "test/classifier" }));
	assert.deepEqual(noAuth.lastNotification(), { message: "No API key for test", type: "error" });

	assert.deepEqual(saved, []);
});

test("a role chosen from the list must resolve, like /automode model @role", async () => {
	const saved: SettingUpdate[] = [];
	const h = await createHarness(memoryStore(saved), { answers: ["@smol"] });
	// The role list offers @smol, but by the time it is validated the chain is empty.
	const chains: Record<string, Model<Api>[]> = { smol: [HAIKU] };
	const bridge = fakeBridge({ chains, roles: ["smol"] });
	const roleChain = bridge.roleChain;
	let calls = 0;
	bridge.roleChain = (role, registry) => {
		calls += 1;
		return calls === 1 ? roleChain(role, registry) : [];
	};

	await h.run("model", bridge);

	assert.deepEqual(saved, []);
	assert.deepEqual(h.lastNotification(), { message: "@smol resolves to no available model", type: "error" });
});

test("a failing OMP picker falls back to the plain model list", async () => {
	const saved: SettingUpdate[] = [];
	const bridge = fakeBridge({ chains: { smol: [HAIKU] }, picked: new Error("picker moved") });
	const h = await createHarness(memoryStore(saved), { answers: [BROWSE_OPTION], customResult: "test/classifier" });

	await h.run("model", bridge);

	assert.equal(h.customCalls, 1);
	assert.deepEqual(saved, [{ key: "classifierModel", value: "test/classifier" }]);
	const warning = h.ctx.notifications.find(({ type }) => type === "warning")!;
	assert.match(warning.message, /OMP model picker unavailable \(picker moved\)/);
});

test("under Pi /automode model without arguments shows the plain model list", async () => {
	const saved: SettingUpdate[] = [];
	const h = await createHarness(memoryStore(saved), { customResult: "test/classifier" });

	await h.run("model");

	assert.equal(h.customCalls, 1);
	assert.equal(h.selectCalls.length, 0);
	assert.deepEqual(saved, [{ key: "classifierModel", value: "test/classifier" }]);
});

test("dismissing the classifier prompt leaves the model unchanged", async () => {
	const saved: SettingUpdate[] = [];
	const underOmp = await createHarness(memoryStore(saved), { answers: [undefined] });
	await underOmp.run("model", fakeBridge({ chains: { smol: [HAIKU] } }));
	assert.deepEqual(underOmp.lastNotification(), { message: "Classifier model unchanged", type: "info" });

	const underPi = await createHarness(memoryStore(saved), { customResult: undefined });
	await underPi.run("model");
	assert.deepEqual(underPi.lastNotification(), { message: "Classifier model unchanged", type: "info" });
	assert.deepEqual(saved, []);
});

test("the OMP prompt offers Jev only when a TypeSafe key is set", async () => {
	const bridge = fakeBridge({ chains: { smol: [HAIKU] } });
	const savedWithKey: SettingUpdate[] = [];
	const withKey = await createHarness(memoryStore(savedWithKey), { answers: ["typesafe/jev-latest"] });
	await withEnv("TYPESAFE_API_KEY", "test-jev-key", () => withKey.run("model", bridge));
	assert.deepEqual(withKey.selectCalls[0]!.options, [
		"@smol → anthropic/claude-haiku-5-5 (current)",
		"typesafe/jev-latest (TypeSafe Jev)",
		BROWSE_OPTION,
	]);
	assert.deepEqual(savedWithKey, [{ key: "classifierModel", value: "typesafe/jev-latest" }]);

	const withoutKey = await createHarness(memoryStore([]), {});
	await withEnv("TYPESAFE_API_KEY", undefined, () => withoutKey.run("model", bridge));
	assert.deepEqual(withoutKey.selectCalls[0]!.options, [
		"@smol → anthropic/claude-haiku-5-5 (current)",
		BROWSE_OPTION,
	]);
});

test("without a UI /automode settings prints the current settings and where to change them", async () => {
	await withTempDir((dir) => withInline({ autoMode: { classifierStrategy: "hybrid" } }, async () => {
		const globalPath = join(dir, "global.json");
		const h = await createHarness({
			prepareGlobalConfig: () => ({ status: "current", activePath: globalPath }),
		}, { cwd: dir, hasUI: false });

		await h.run("settings");

		assert.equal(h.selectCalls.length, 0);
		assert.equal(h.ctx.notifications.length, 1);
		const [{ message, type }] = h.ctx.notifications;
		assert.equal(type, "info");
		assert.match(message, /^\/automode settings needs an interactive UI\. Current settings:/);
		assert.match(message, /Classifier strategy: hybrid \[PI_AUTOMODE_SETTINGS_JSON\]/);
		assert.match(message, /Enabled: on \[default\]/);
		assert.ok(message.includes(`edit ${globalPath}`));
	}));
});

test("without a UI /automode model with no argument changes nothing", async () => {
	const saved: SettingUpdate[] = [];
	const h = await createHarness(memoryStore(saved), { hasUI: false });

	await h.run("model", fakeBridge({ chains: { smol: [HAIKU] } }));

	assert.deepEqual(saved, []);
	assert.deepEqual(h.lastNotification(), { message: "Classifier model unchanged", type: "info" });
});

test("usage and the command description list settings and the model selector forms", async () => {
	const h = await createHarness(memoryStore([]));

	await h.run("bogus");

	assert.deepEqual(h.lastNotification(), {
		message: "Usage: /automode [status|on|off|reload|reset|defaults|config|denials|settings|model [provider/id|@role]]",
		type: "error",
	});
	assert.match(h.fake.commands.get("automode")!.description ?? "", /denials, settings, model$/);
});
