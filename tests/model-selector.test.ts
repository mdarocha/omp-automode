import test from "node:test";
import assert from "node:assert/strict";
import {
	buildEffectiveConfigFromSources,
	parseClassifierSelector,
	validateSettingsFile,
} from "../extensions/auto-mode.ts";

test("classifier selector parses OMP role aliases", () => {
	assert.deepEqual(parseClassifierSelector("@smol"), { kind: "role", role: "smol" });
	assert.deepEqual(parseClassifierSelector("@judge"), { kind: "role", role: "judge" });
	assert.deepEqual(parseClassifierSelector("@my-custom_role.2"), { kind: "role", role: "my-custom_role.2" });
});

test("classifier selector parses provider/id and Jev specs", () => {
	assert.deepEqual(parseClassifierSelector("anthropic/claude-haiku-5-5"), {
		kind: "model",
		provider: "anthropic",
		id: "claude-haiku-5-5",
	});
	assert.deepEqual(parseClassifierSelector("openrouter/typesafe/jev-1.14"), {
		kind: "model",
		provider: "openrouter",
		id: "typesafe/jev-1.14",
	});
	assert.deepEqual(parseClassifierSelector("typesafe/jev-latest"), { kind: "jev", id: "jev-latest" });
});

test("classifier selector rejects malformed specs", () => {
	for (const spec of ["", "@", "@@smol", "@smol:high", "@sm ol", "@/x", "claude", "/id", "provider/", " @smol"]) {
		assert.equal(parseClassifierSelector(spec), undefined, JSON.stringify(spec));
	}
});

test("config accepts role selectors for classifierModel", () => {
	const settings = { autoMode: { classifierModel: "@smol" } };
	assert.deepEqual(validateSettingsFile(settings, "test"), []);
	const config = buildEffectiveConfigFromSources({ globalSettings: [settings] });
	assert.equal(config.classifierModel, "@smol");
});

test("config diagnostics name both accepted classifierModel forms", () => {
	const diagnostics = validateSettingsFile({ autoMode: { classifierModel: "smol" } }, "test");
	assert.equal(diagnostics.length, 1);
	assert.match(diagnostics[0]!, /provider\/model string or an @role selector/);
	const config = buildEffectiveConfigFromSources({ globalSettings: [{ autoMode: { classifierModel: "smol" } }] });
	assert.equal(config.classifierModel, undefined);
});
