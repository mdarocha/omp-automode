import { spawnSync } from "node:child_process";
import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import assert from "node:assert/strict";
import {
	PI_CONFIG_LOCATIONS,
	PI_GLOBAL_SETTINGS,
	PI_LEGACY_GLOBAL_SETTINGS,
	createPiAutomode,
	deterministicHardDeny,
	loadEffectiveConfigWithDiagnostics,
	ompConfigLocations,
	registerOmpAgentDir,
	resolveConfigLocations,
	resolveLogPath,
	selectLegacyGlobalConfigPath,
} from "../extensions/auto-mode.ts";
import {
	baseConfig,
	createFakeCtx,
	createFakePi,
	setupHookTest,
} from "./test-helpers.ts";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OMP_PROJECT_DIRS = [".omp", ".pi"];

function withTempDir<T>(prefix: string, body: (dir: string) => T): T {
	const dir = mkdtempSync(join(os.tmpdir(), prefix));
	try {
		return body(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

function withoutInlineSettings<T>(body: () => T): T {
	const previous = process.env.PI_AUTOMODE_SETTINGS_JSON;
	delete process.env.PI_AUTOMODE_SETTINGS_JSON;
	try {
		return body();
	} finally {
		if (previous !== undefined) {
			process.env.PI_AUTOMODE_SETTINGS_JSON = previous;
		}
	}
}

function ompPi(agentDir: string) {
	const fake = createFakePi();
	Object.assign(fake.pi, { pi: { getAgentDir: () => agentDir } });
	return fake;
}

type RuntimeReport = {
	notifications: Array<{ message: string; type?: string }>;
	details: {
		config: { classifierModel?: string };
		configSources: {
			runtime: string;
			agentDir?: string;
			global: string;
			projectLocal: string;
			projectShared: string;
		};
		diagnostics: string[];
	};
};

/**
 * Run the real extension (real global config preparation) in a child process
 * whose HOME is a temp dir, so migrations never touch the developer's files.
 */
function runExtensionInHome(
	home: string,
	options: { agentDir?: string; cwd: string },
): RuntimeReport {
	const script = `
		import { createFakeCtx, createFakePi } from ${JSON.stringify(join(REPO_ROOT, "tests/test-helpers.ts"))};
		import { createPiAutomode } from ${JSON.stringify(join(REPO_ROOT, "extensions/auto-mode.ts"))};
		const fake = createFakePi();
		if (process.env.TEST_AGENT_DIR) {
			fake.pi.pi = { getAgentDir: () => process.env.TEST_AGENT_DIR };
		}
		createPiAutomode()(fake.pi);
		const ctx = createFakeCtx(fake.entries, { cwd: process.env.TEST_CWD });
		await fake.emit("session_start", { type: "session_start" }, ctx);
		const output = await fake.tools.get("automode_inspect").execute(
			"call", { action: "config" }, undefined, undefined, ctx,
		);
		console.log(JSON.stringify({ notifications: ctx.notifications, details: output.details }));
	`;
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: home,
		USERPROFILE: home,
		TEST_CWD: options.cwd,
	};
	delete env.PI_AUTOMODE_SETTINGS_JSON;
	delete env.TEST_AGENT_DIR;
	if (options.agentDir) {
		env.TEST_AGENT_DIR = options.agentDir;
	}
	const child = spawnSync(
		process.execPath,
		["--import", "tsx", "--input-type=module", "--eval", script],
		{ cwd: REPO_ROOT, env, encoding: "utf8" },
	);
	assert.equal(child.status, 0, child.stderr);
	return JSON.parse(child.stdout.trim().split("\n").at(-1) ?? "") as RuntimeReport;
}

test("config locations fall back to Pi paths without the omp namespace", () => {
	assert.equal(resolveConfigLocations(undefined), PI_CONFIG_LOCATIONS);
	assert.equal(resolveConfigLocations({}), PI_CONFIG_LOCATIONS);
	assert.equal(resolveConfigLocations({ pi: {} }), PI_CONFIG_LOCATIONS);
	assert.equal(
		resolveConfigLocations({ pi: { getAgentDir: "not a function" } }),
		PI_CONFIG_LOCATIONS,
	);
	assert.equal(PI_CONFIG_LOCATIONS.runtime, "pi");
	assert.equal(PI_CONFIG_LOCATIONS.globalConfigPath, PI_GLOBAL_SETTINGS[0]);
	assert.deepEqual(PI_CONFIG_LOCATIONS.legacyGlobalConfigPaths, [
		PI_LEGACY_GLOBAL_SETTINGS,
	]);
	assert.deepEqual(PI_CONFIG_LOCATIONS.projectConfigDirs, [".pi"]);
	assert.equal(PI_CONFIG_LOCATIONS.logRoot, undefined);
});

test("config locations use omp's agent directory", () => {
	const agentDir = "/srv/omp-profile/agent";
	const locations = resolveConfigLocations({ pi: { getAgentDir: () => agentDir } });
	assert.equal(locations.runtime, "omp");
	assert.equal(locations.agentDir, agentDir);
	assert.equal(locations.globalConfigPath, join(agentDir, "automode/config.json"));
	assert.equal(locations.logRoot, join(agentDir, "automode/logs"));
	assert.deepEqual(locations.projectConfigDirs, [".omp", ".pi"]);
	assert.deepEqual(locations.legacyGlobalConfigPaths, [
		...PI_GLOBAL_SETTINGS,
		PI_LEGACY_GLOBAL_SETTINGS,
	]);
});

test("config locations fall back to Pi paths when getAgentDir is unusable", () => {
	assert.equal(
		resolveConfigLocations({ pi: { getAgentDir: () => { throw new Error("boom"); } } }),
		PI_CONFIG_LOCATIONS,
	);
	for (const value of ["", "relative/agent", undefined, 42]) {
		assert.equal(
			resolveConfigLocations({ pi: { getAgentDir: () => value } }),
			PI_CONFIG_LOCATIONS,
			String(value),
		);
	}
});

test("an agent directory that is a legacy path is never migrated onto itself", () => {
	const locations = ompConfigLocations(join(os.homedir(), ".pi/agent/extensions/pi-automode/.."));
	assert.equal(
		locations.legacyGlobalConfigPaths.includes(locations.globalConfigPath),
		false,
	);
});

test("selectLegacyGlobalConfigPath prefers an existing legacy file", () => {
	withTempDir("omp-automode-legacy-select-", (dir) => {
		const first = join(dir, "first.json");
		const second = join(dir, "second.json");
		const locations = {
			...ompConfigLocations(join(dir, "agent")),
			legacyGlobalConfigPaths: [first, second],
		};
		assert.equal(selectLegacyGlobalConfigPath(locations), first);
		writeFileSync(second, "{}\n");
		assert.equal(selectLegacyGlobalConfigPath(locations), second);
		writeFileSync(first, "{}\n");
		assert.equal(selectLegacyGlobalConfigPath(locations), first);
	});
});

test("omp migrates the Pi global config into the agent directory", () => {
	withTempDir("omp-automode-home-migrate-", (home) => {
		const legacy = join(home, ".pi/agent/extensions/pi-automode/config.json");
		const agentDir = join(home, ".omp/agent");
		const current = join(agentDir, "automode/config.json");
		writeJson(legacy, { autoMode: { classifierModel: "test/migrated" } });

		const report = runExtensionInHome(home, { agentDir, cwd: home });

		assert.equal(existsSync(legacy), false);
		assert.equal(
			JSON.parse(readFileSync(current, "utf8")).autoMode.classifierModel,
			"test/migrated",
		);
		assert.equal(report.details.config.classifierModel, "test/migrated");
		assert.equal(report.details.configSources.runtime, "omp");
		assert.equal(report.details.configSources.global, current);
		assert.equal(report.notifications.length, 1);
		assert.equal(report.notifications[0]?.type, "info");
		assert.match(report.notifications[0]?.message ?? "", /moved/i);
	});
});

test("omp migrates the pre-ADR-002 Pi global config when it is the only one", () => {
	withTempDir("omp-automode-home-old-legacy-", (home) => {
		const legacy = join(home, ".pi/agent/automode.json");
		const agentDir = join(home, ".omp/agent");
		const current = join(agentDir, "automode/config.json");
		writeJson(legacy, { autoMode: { classifierModel: "test/oldest" } });

		const report = runExtensionInHome(home, { agentDir, cwd: home });

		assert.equal(existsSync(legacy), false);
		assert.equal(existsSync(current), true);
		assert.equal(report.details.config.classifierModel, "test/oldest");
	});
});

test("omp honours a custom agent directory such as a profile", () => {
	withTempDir("omp-automode-home-profile-", (home) => {
		const agentDir = join(home, "custom/profiles/work/agent");
		const current = join(agentDir, "automode/config.json");
		writeJson(current, { autoMode: { classifierModel: "test/profile" } });

		const report = runExtensionInHome(home, { agentDir, cwd: home });

		assert.equal(report.details.configSources.global, current);
		assert.equal(report.details.configSources.agentDir, agentDir);
		assert.equal(report.details.config.classifierModel, "test/profile");
		assert.equal(existsSync(join(home, ".omp")), false);
	});
});

test("omp reports a conflict and leaves the legacy global config untouched", () => {
	withTempDir("omp-automode-home-conflict-", (home) => {
		const legacy = join(home, ".pi/agent/extensions/pi-automode/config.json");
		const agentDir = join(home, ".omp/agent");
		const current = join(agentDir, "automode/config.json");
		writeJson(legacy, { autoMode: { classifierModel: "test/legacy" } });
		writeJson(current, { autoMode: { classifierModel: "test/current" } });

		const report = runExtensionInHome(home, { agentDir, cwd: home });

		assert.equal(report.details.config.classifierModel, "test/current");
		assert.equal(report.details.configSources.global, current);
		assert.equal(
			JSON.parse(readFileSync(legacy, "utf8")).autoMode.classifierModel,
			"test/legacy",
		);
		assert.equal(report.notifications[0]?.type, "warning");
		assert.match(report.notifications[0]?.message ?? "", /conflict/i);
		assert.match(report.details.diagnostics.join("\n"), /conflict/i);
	});
});

test("omp falls back to the legacy global config when migration fails", () => {
	withTempDir("omp-automode-home-failed-", (home) => {
		const legacy = join(home, ".pi/agent/extensions/pi-automode/config.json");
		const agentDir = join(home, ".omp/agent");
		writeJson(legacy, { autoMode: { classifierModel: "test/legacy" } });
		// A file where the data directory belongs makes the destination unusable.
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "automode"), "not a directory");

		const report = runExtensionInHome(home, { agentDir, cwd: home });

		assert.equal(existsSync(legacy), true);
		assert.equal(report.details.config.classifierModel, "test/legacy");
		assert.equal(report.details.configSources.global, legacy);
		assert.equal(report.notifications[0]?.type, "warning");
		assert.match(report.details.diagnostics.join("\n"), /Could not move Auto Mode config/);
	});
});

test("omp creates nothing when no global config exists and plans the new path", () => {
	withTempDir("omp-automode-home-empty-", (home) => {
		const agentDir = join(home, ".omp/agent");

		const report = runExtensionInHome(home, { agentDir, cwd: home });

		assert.equal(report.details.configSources.global, join(agentDir, "automode/config.json"));
		assert.equal(existsSync(join(agentDir, "automode")), false);
		assert.deepEqual(report.notifications, []);
	});
});

test("Pi without the omp namespace keeps the ADR-002 global path and project dir", () => {
	withTempDir("omp-automode-home-pi-", (home) => {
		const legacy = join(home, ".pi/agent/automode.json");
		const current = join(home, ".pi/agent/extensions/pi-automode/config.json");
		writeJson(legacy, { autoMode: { classifierModel: "test/pi" } });

		const report = runExtensionInHome(home, { cwd: home });

		assert.equal(existsSync(legacy), false);
		assert.equal(existsSync(current), true);
		assert.equal(existsSync(join(home, ".omp")), false);
		assert.equal(report.details.config.classifierModel, "test/pi");
		assert.deepEqual(report.details.configSources, {
			runtime: "pi",
			global: current,
			projectLocal: join(home, ".pi/automode.local.json"),
			projectShared: join(home, ".pi/automode.json"),
		});
	});
});

test("Pi ignores .omp project config", () => {
	withoutInlineSettings(() =>
		withTempDir("omp-automode-pi-project-", (dir) => {
			writeJson(join(dir, ".omp/automode.local.json"), {
				autoMode: { classifierModel: "project/omp" },
			});
			const loaded = loadEffectiveConfigWithDiagnostics(
				dir,
				true,
				join(dir, "missing.json"),
			);
			assert.notEqual(loaded.config.classifierModel, "project/omp");
			assert.equal(loaded.sources?.projectLocal, join(dir, ".pi/automode.local.json"));
			assert.deepEqual(loaded.diagnostics, []);
		})
	);
});

test("omp project config prefers .omp over .pi", () => {
	withoutInlineSettings(() =>
		withTempDir("omp-automode-project-prefer-", (dir) => {
			const ompLocal = join(dir, ".omp/automode.local.json");
			const piLocal = join(dir, ".pi/automode.local.json");
			writeJson(ompLocal, { autoMode: { classifierModel: "project/omp" } });
			writeJson(piLocal, { autoMode: { classifierModel: "project/pi" } });

			const loaded = loadEffectiveConfigWithDiagnostics(
				dir,
				true,
				join(dir, "missing.json"),
				OMP_PROJECT_DIRS,
			);

			assert.equal(loaded.config.classifierModel, "project/omp");
			assert.equal(loaded.sources?.projectLocal, ompLocal);
			assert.deepEqual(loaded.diagnostics, [
				`${piLocal}: ignored because ${ompLocal} exists`,
			]);
		})
	);
});

test("omp project config falls back to .pi per file without moving it", () => {
	withoutInlineSettings(() =>
		withTempDir("omp-automode-project-fallback-", (dir) => {
			const ompShared = join(dir, ".omp/automode.json");
			const piLocal = join(dir, ".pi/automode.local.json");
			writeJson(piLocal, { autoMode: { classifierModel: "project/pi" } });
			writeJson(ompShared, { permissions: { deny: ["bash(omp-shared *)"] } });

			const loaded = loadEffectiveConfigWithDiagnostics(
				dir,
				true,
				join(dir, "missing.json"),
				OMP_PROJECT_DIRS,
			);

			assert.equal(loaded.config.classifierModel, "project/pi");
			assert.equal(
				loaded.config.permissionDeny.some((pattern) => pattern.raw === "bash(omp-shared *)"),
				true,
			);
			assert.equal(loaded.sources?.projectLocal, piLocal);
			assert.equal(loaded.sources?.projectShared, ompShared);
			assert.deepEqual(loaded.diagnostics, [
				`${piLocal}: using legacy project config location; move it to ${join(dir, ".omp/automode.local.json")}`,
			]);
			assert.equal(existsSync(piLocal), true);
			assert.equal(existsSync(join(dir, ".omp/automode.local.json")), false);
		})
	);
});

test("omp project config with no file plans the .omp path", () => {
	withoutInlineSettings(() =>
		withTempDir("omp-automode-project-none-", (dir) => {
			const loaded = loadEffectiveConfigWithDiagnostics(
				dir,
				true,
				join(dir, "missing.json"),
				OMP_PROJECT_DIRS,
			);
			assert.equal(loaded.sources?.projectLocal, join(dir, ".omp/automode.local.json"));
			assert.equal(loaded.sources?.projectShared, join(dir, ".omp/automode.json"));
			assert.deepEqual(loaded.diagnostics, []);
		})
	);
});

test("omp untrusted projects ignore both .omp and .pi files", () => {
	withoutInlineSettings(() =>
		withTempDir("omp-automode-project-untrusted-", (dir) => {
			const ompLocal = join(dir, ".omp/automode.local.json");
			const piShared = join(dir, ".pi/automode.json");
			writeJson(ompLocal, { autoMode: { classifierModel: "project/omp" } });
			writeJson(piShared, { permissions: { deny: ["bash(pi-shared *)"] } });

			const loaded = loadEffectiveConfigWithDiagnostics(
				dir,
				false,
				join(dir, "missing.json"),
				OMP_PROJECT_DIRS,
			);

			assert.notEqual(loaded.config.classifierModel, "project/omp");
			assert.equal(
				loaded.config.permissionDeny.some((pattern) => pattern.raw === "bash(pi-shared *)"),
				false,
			);
			assert.deepEqual(loaded.diagnostics.sort(), [
				`${ompLocal}: ignored because project is not trusted`,
				`${piShared}: ignored because project is not trusted`,
			].sort());
		})
	);
});

test("the .omp shared project file still cannot weaken auto mode", () => {
	withoutInlineSettings(() =>
		withTempDir("omp-automode-project-shared-", (dir) => {
			writeJson(join(dir, ".omp/automode.json"), {
				autoMode: { enabled: false },
				permissions: { allow: ["bash(rm *)"] },
			});
			const loaded = loadEffectiveConfigWithDiagnostics(
				dir,
				true,
				join(dir, "missing.json"),
				OMP_PROJECT_DIRS,
			);
			assert.equal(loaded.config.enabled, true);
			assert.equal(loaded.config.permissionAllow.length, 0);
		})
	);
});

test("omp inspection reports the agent-directory config path and log root", async () => {
	await withTempDir("omp-automode-inspect-", async (dir) => {
		const agentDir = join(dir, "agent");
		const fake = ompPi(agentDir);
		createPiAutomode({ loadConfig: () => baseConfig(), now: () => new Date("2026-08-21T12:00:00.000Z") })(fake.pi);
		const ctx = createFakeCtx(fake.entries, { cwd: dir, sessionDir: "", sessionId: "s1" });
		await fake.emit("session_start", { type: "session_start" }, ctx);

		const output = await fake.tools.get("automode_inspect")?.execute(
			"call-omp-inspect",
			{ action: "config" },
			undefined,
			undefined,
			ctx,
		);
		const details = output.details;
		assert.equal(details.configSources.runtime, "omp");
		assert.equal(details.configSources.global, join(agentDir, "automode/config.json"));
		assert.equal(
			details.logFile,
			resolveLogPath(
				undefined,
				"",
				"s1",
				dir,
				join(agentDir, "automode/logs"),
				new Date("2026-08-21T12:00:00.000Z"),
			),
		);
		assert.match(details.logFile, new RegExp(`^${join(agentDir, "automode/logs").replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}`));
	});
});

test("an explicit logRoot option wins over the omp log root", async () => {
	await withTempDir("omp-automode-inspect-logroot-", async (dir) => {
		const fake = ompPi(join(dir, "agent"));
		const logRoot = join(dir, "explicit-logs");
		createPiAutomode({ loadConfig: () => baseConfig(), logRoot })(fake.pi);
		const ctx = createFakeCtx(fake.entries, { cwd: dir, sessionDir: "", sessionId: "s1" });
		await fake.emit("session_start", { type: "session_start" }, ctx);
		const output = await fake.tools.get("automode_inspect")?.execute(
			"call", { action: "config" }, undefined, undefined, ctx,
		);
		assert.ok((output.details.logFile as string).startsWith(logRoot));
	});
});

test("Pi inspection keeps the Pi global path and log root", async () => {
	const fake = createFakePi();
	createPiAutomode({ loadConfig: () => baseConfig() })(fake.pi);
	const ctx = createFakeCtx(fake.entries, { sessionDir: "", sessionId: "s1" });
	await fake.emit("session_start", { type: "session_start" }, ctx);
	const output = await fake.tools.get("automode_inspect")?.execute(
		"call", { action: "config" }, undefined, undefined, ctx,
	);
	assert.equal(output.details.configSources.runtime, "pi");
	assert.equal(output.details.configSources.global, PI_GLOBAL_SETTINGS[0]);
	assert.ok(
		(output.details.logFile as string).startsWith(
			join(os.homedir(), ".pi/agent/extensions/pi-automode/logs"),
		),
	);
});

test("deterministic hard deny protects omp automode files and agent directories", () => {
	const cwd = "/tmp/project";
	const agentDir = join(os.homedir(), ".omp/agent");
	for (const path of [
		".omp/automode.local.json",
		".omp/automode.json",
		"nested/.omp/automode.local.json",
		join(agentDir, "automode/config.json"),
		join(agentDir, "automode/logs/session.jsonl"),
		join(agentDir, "extensions/anything.ts"),
		join(os.homedir(), ".OMP/AGENT/AUTOMODE/config.json"),
	]) {
		for (const toolName of ["write", "edit"]) {
			assert.match(
				deterministicHardDeny(toolName, { path }, cwd) ?? "",
				/safety-control/,
				`${toolName} ${path}`,
			);
		}
	}
});

test("deterministic hard deny protects omp automode files from Bash writes", () => {
	const cwd = "/tmp/project";
	const agentDir = join(os.homedir(), ".omp/agent");
	for (const command of [
		"echo '{}' > .omp/automode.local.json",
		"cp /tmp/x.json .omp/automode.json",
		"tee .omp/automode.local.json < /tmp/x.json",
		`echo '{}' > ${agentDir}/automode/config.json`,
		`mv /tmp/x.json ${agentDir}/automode/config.json`,
		"sed -i s/true/false/ ~/.omp/agent/automode/config.json",
	]) {
		assert.match(
			deterministicHardDeny("bash", { command }, cwd) ?? "",
			/safety-control/,
			command,
		);
	}
});

test("omp protection follows the active agent directory", async () => {
	await withTempDir("omp-automode-protect-agent-", async (dir) => {
		const agentDir = join(dir, "profiles/work/agent");
		const target = join(agentDir, "automode/config.json");
		assert.equal(deterministicHardDeny("write", { path: target }, "/tmp/project"), undefined);

		const fake = ompPi(agentDir);
		createPiAutomode({ loadConfig: () => baseConfig() })(fake.pi);

		for (const path of [
			target,
			join(agentDir, "automode/logs/x.jsonl"),
			join(agentDir, "extensions/x.ts"),
		]) {
			assert.match(
				deterministicHardDeny("write", { path }, "/tmp/project") ?? "",
				/safety-control/,
				path,
			);
		}
		assert.equal(
			deterministicHardDeny("write", { path: join(agentDir, "sessions/x.jsonl") }, "/tmp/project"),
			undefined,
		);
	});
});

test("registerOmpAgentDir protects an agent directory directly", () => {
	registerOmpAgentDir("/srv/direct/agent");
	assert.match(
		deterministicHardDeny("write", { path: "/srv/direct/agent/automode/config.json" }, "/tmp/project") ?? "",
		/safety-control/,
	);
});

test("Pi safety-control paths are unchanged", () => {
	const cwd = "/tmp/project";
	for (const path of [
		".pi/automode.local.json",
		".pi/automode.json",
		join(os.homedir(), ".pi/agent/extensions/pi-automode/config.json"),
		join(os.homedir(), ".pi/agent/settings.json"),
	]) {
		assert.match(
			deterministicHardDeny("write", { path }, cwd) ?? "",
			/safety-control/,
			path,
		);
	}
	assert.equal(deterministicHardDeny("write", { path: "src/automation.ts" }, cwd), undefined);
	assert.equal(deterministicHardDeny("write", { path: ".omp/skills/note.md" }, cwd), undefined);
});

test("tool_call hook blocks writes to .omp/automode.local.json before the classifier", async () => {
	const harness = await setupHookTest();

	const result = await harness.emit("tool_call", {
		toolName: "write",
		input: { path: ".omp/automode.local.json", content: "{}" },
	}, harness.ctx) as { block?: boolean; reason?: string };

	assert.equal(result.block, true);
	assert.match(result.reason ?? "", /safety-control/);
	assert.equal(harness.classifierCalls, 0);
});
