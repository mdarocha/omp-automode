import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	loadEffectiveConfigWithDiagnostics,
	PI_PROJECT_DIR,
	PROJECT_LOCAL_SETTINGS_FILE,
	writeGlobalSetting,
	type SettingsFile,
	type SettingUpdate,
} from "../extensions/auto-mode.ts";
import { withInline, withTempDir } from "./test-helpers.ts";

function readJson(path: string): SettingsFile {
	return JSON.parse(readFileSync(path, "utf8")) as SettingsFile;
}

test("writeGlobalSetting writes each editable setting and creates the file", () => {
	withTempDir((dir) => {
		const path = join(dir, "nested/config.json");
		const updates: SettingUpdate[] = [
			{ key: "enabled", value: false },
			{ key: "classifierStrategy", value: "hybrid" },
			{ key: "classifierModel", value: "@judge" },
			{ key: "judgeConfidence", value: 0.75 },
			{ key: "classifierReasoningLevel", value: "high" },
			{ key: "log.enabled", value: true },
			{ key: "log.classifierIo", value: true },
		];
		for (const update of updates) {
			writeGlobalSetting(update, path);
		}
		assert.deepEqual(readJson(path), {
			autoMode: {
				enabled: false,
				classifierStrategy: "hybrid",
				classifierModel: "@judge",
				judgeConfidence: 0.75,
				classifierReasoningLevel: "high",
				log: { enabled: true, classifierIo: true },
			},
		});
	});
});

test("writeGlobalSetting preserves unrelated keys and sibling log keys", () => {
	withTempDir((dir) => {
		const path = join(dir, "config.json");
		const original = {
			permissions: { deny: ["bash(rm -rf *)"] },
			autoMode: {
				allow: ["$defaults", "custom allow"],
				classifierTimeoutMs: 5000,
				log: { enabled: false, classifierIo: true },
			},
			futureKey: { keep: true },
		};
		writeFileSync(path, JSON.stringify(original));

		writeGlobalSetting({ key: "log.enabled", value: true }, path);
		writeGlobalSetting({ key: "classifierStrategy", value: "detailed" }, path);

		assert.deepEqual(readJson(path), {
			...original,
			autoMode: {
				...original.autoMode,
				classifierStrategy: "detailed",
				log: { enabled: true, classifierIo: true },
			},
		});
	});
});

test("writeGlobalSetting removes the reasoning level when it is unset", () => {
	withTempDir((dir) => {
		const path = join(dir, "config.json");
		writeFileSync(path, JSON.stringify({ autoMode: { classifierReasoningLevel: "low", enabled: true } }));

		writeGlobalSetting({ key: "classifierReasoningLevel", value: undefined }, path);

		assert.deepEqual(readJson(path), { autoMode: { enabled: true } });
	});
});

test("writeGlobalSetting rejects invalid values and leaves the file untouched", () => {
	withTempDir((dir) => {
		const path = join(dir, "config.json");
		const original = JSON.stringify({ autoMode: { enabled: true } });
		writeFileSync(path, original);
		const invalid: unknown[] = [
			{ key: "classifierStrategy", value: "fast" },
			{ key: "judgeConfidence", value: 0.5 },
			{ key: "judgeConfidence", value: 1.01 },
			{ key: "judgeConfidence", value: "0.9" },
			{ key: "judgeConfidence", value: Number.NaN },
			{ key: "classifierReasoningLevel", value: "extreme" },
			{ key: "classifierModel", value: "smol" },
			{ key: "classifierModel", value: undefined },
			{ key: "enabled", value: "yes" },
			{ key: "log.enabled", value: 1 },
			{ key: "log.classifierIo", value: "true" },
			{ key: "timeout", value: 5 },
		];
		for (const update of invalid) {
			assert.throws(
				() => writeGlobalSetting(update as SettingUpdate, path),
				/invalid value/i,
				JSON.stringify(update),
			);
		}
		assert.equal(readFileSync(path, "utf8"), original);
	});
});

test("writeGlobalSetting accepts the confidence bounds 1 and just above 0.5", () => {
	withTempDir((dir) => {
		const path = join(dir, "config.json");
		writeGlobalSetting({ key: "judgeConfidence", value: 1 }, path);
		assert.equal(readJson(path).autoMode?.judgeConfidence, 1);
		writeGlobalSetting({ key: "judgeConfidence", value: 0.51 }, path);
		assert.equal(readJson(path).autoMode?.judgeConfidence, 0.51);
	});
});

test("writeGlobalSetting refuses a file whose autoMode or log section is not an object", () => {
	withTempDir((dir) => {
		const path = join(dir, "config.json");
		writeFileSync(path, JSON.stringify({ autoMode: [] }));
		assert.throws(
			() => writeGlobalSetting({ key: "enabled", value: true }, path),
			/autoMode must be a JSON object/,
		);
		writeFileSync(path, JSON.stringify({ autoMode: { log: "yes" } }));
		assert.throws(
			() => writeGlobalSetting({ key: "log.enabled", value: true }, path),
			/autoMode\.log must be a JSON object/,
		);
	});
});

test("provenance reports defaults when no source sets a value", () => {
	withTempDir((dir) => {
		const globalPath = join(dir, "global.json");
		const result = withInline(undefined, () => loadEffectiveConfigWithDiagnostics(dir, true, globalPath));
		for (const source of Object.values(result.provenance ?? {})) {
			assert.deepEqual(source, { kind: "default" });
		}
		assert.equal(Object.keys(result.provenance ?? {}).length, 7);
	});
});

test("provenance names the global file, the project-local file, and the inline JSON", () => {
	withTempDir((dir) => {
		const globalPath = join(dir, "global.json");
		const localPath = join(dir, PI_PROJECT_DIR, PROJECT_LOCAL_SETTINGS_FILE);
		mkdirSync(join(localPath, ".."), { recursive: true });
		writeFileSync(globalPath, JSON.stringify({
			autoMode: {
				enabled: false,
				classifierStrategy: "detailed",
				classifierModel: "@smol",
				judgeConfidence: 0.8,
				log: { enabled: true },
			},
		}));
		writeFileSync(localPath, JSON.stringify({
			autoMode: { classifierStrategy: "hybrid", classifierModel: "@judge", log: { classifierIo: true } },
		}));
		const inline = { autoMode: { classifierModel: "test/inline", judgeConfidence: 0.95 } };

		const result = withInline(inline, () => loadEffectiveConfigWithDiagnostics(dir, true, globalPath));

		assert.deepEqual(result.provenance, {
			enabled: { kind: "global", path: globalPath },
			classifierStrategy: { kind: "project-local", path: localPath },
			classifierModel: { kind: "inline" },
			judgeConfidence: { kind: "inline" },
			classifierReasoningLevel: { kind: "default" },
			"log.enabled": { kind: "global", path: globalPath },
			"log.classifierIo": { kind: "project-local", path: localPath },
		});
		assert.equal(result.config.classifierModel, "test/inline");
		assert.equal(result.config.classifierStrategy, "hybrid");
		assert.equal(result.config.judgeConfidence, 0.95);
	});
});

test("provenance ignores invalid values, which the merge also ignores", () => {
	withTempDir((dir) => {
		const globalPath = join(dir, "global.json");
		writeFileSync(globalPath, JSON.stringify({ autoMode: { classifierStrategy: "detailed", enabled: false } }));
		const inline = { autoMode: { classifierStrategy: "bogus", enabled: "no", judgeConfidence: 2 } };

		const result = withInline(inline, () => loadEffectiveConfigWithDiagnostics(dir, true, globalPath));

		assert.deepEqual(result.provenance?.classifierStrategy, { kind: "global", path: globalPath });
		assert.deepEqual(result.provenance?.enabled, { kind: "global", path: globalPath });
		assert.deepEqual(result.provenance?.judgeConfidence, { kind: "default" });
		assert.equal(result.config.classifierStrategy, "detailed");
	});
});

test("provenance skips the project-local file while the project is untrusted", () => {
	withTempDir((dir) => {
		const globalPath = join(dir, "global.json");
		const localPath = join(dir, PI_PROJECT_DIR, PROJECT_LOCAL_SETTINGS_FILE);
		mkdirSync(join(localPath, ".."), { recursive: true });
		writeFileSync(localPath, JSON.stringify({ autoMode: { classifierStrategy: "hybrid" } }));

		const result = withInline(undefined, () => loadEffectiveConfigWithDiagnostics(dir, false, globalPath));

		assert.deepEqual(result.provenance?.classifierStrategy, { kind: "default" });
		assert.equal(result.config.classifierStrategy, "staged");
	});
});
