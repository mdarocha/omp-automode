import test from "node:test";
import assert from "node:assert/strict";
import {
	parseToolPattern,
	FALLBACK_STATUS_ICON,
	statusIcon,
	statusLine,
	statusText,
} from "../extensions/auto-mode.ts";
import {
	baseConfig,
	baseState,
	createFakeCtx,
	setupHookTest,
} from "./test-helpers.ts";

test("statusText reports the permissions.allow rule count", () => {
	const pattern = parseToolPattern("noop");
	assert.ok(pattern);
	const text = statusText(baseConfig({ permissionAllow: [pattern] }), baseState());
	assert.match(text, /permissions\.allow rules: 1/);
});

test("statusText reports server-default classifier reasoning", () => {
	const text = statusText(baseConfig(), baseState());
	assert.match(text, /^classifier reasoning: server default$/m);
});

test("statusText reports the configured classifier reasoning level", () => {
	const text = statusText(
		baseConfig({ classifierReasoningLevel: "high" }),
		baseState(),
	);
	assert.match(text, /^classifier reasoning: high$/m);
});

const ICON = "◆";

test("statusLine: enabled shows the icon and auto", () => {
	assert.equal(statusLine(baseConfig(), baseState(), ICON), `${ICON} auto`);
});

test("statusLine: enabled with blocks appends the blocked count", () => {
	const state = baseState({ checkedActions: 6, blockedActions: 2 });
	assert.equal(statusLine(baseConfig(), state, ICON), `${ICON} auto · 2 blocked`);
});

test("statusLine: classifier counters do not change the text", () => {
	const state = baseState({ checkedActions: 6, classifierAllowed: 4 });
	assert.equal(statusLine(baseConfig(), state, ICON), `${ICON} auto`);
});

test("statusLine: disabled shows off and drops the blocked count", () => {
	const state = baseState({ checkedActions: 6, blockedActions: 3 });
	assert.equal(statusLine(baseConfig({ enabled: false }), state, ICON), `${ICON} off`);
});

test("statusLine: a classifier call in flight shows checking", () => {
	const state = baseState({ blockedActions: 2 });
	assert.equal(statusLine(baseConfig(), state, ICON, true), `${ICON} checking…`);
});

test("statusLine: checking never shows while disabled", () => {
	assert.equal(statusLine(baseConfig({ enabled: false }), baseState(), ICON, true), `${ICON} off`);
});

test("statusIcon prefers the omp shield glyph", () => {
	assert.equal(statusIcon({ cmd: { shield: "S" }, icon: { auto: "A" } }), "S");
});

test("statusIcon falls back to the omp auto icon when the preset has no shield", () => {
	assert.equal(statusIcon({ cmd: { shield: "" }, icon: { auto: "[A]" } }), "[A]");
});

test("statusIcon falls back to a plain glyph on themes without icons", () => {
	assert.equal(statusIcon({}), FALLBACK_STATUS_ICON);
	assert.equal(statusIcon(undefined), FALLBACK_STATUS_ICON);
});

const statusTexts = (ctx: ReturnType<typeof createFakeCtx>) =>
	ctx.statuses.map(({ text }) => text);

test("session_start publishes the compact status", async () => {
	const harness = await setupHookTest();
	assert.deepEqual(statusTexts(harness.ctx), [`${FALLBACK_STATUS_ICON} auto`]);
});

test("session_start uses the theme icon when the theme has one", async () => {
	const ctx = createFakeCtx();
	(ctx.ui.theme as any).cmd = { shield: "S" };
	await setupHookTest({ ctx });
	assert.deepEqual(statusTexts(ctx), ["S auto"]);
});

test("tool_call shows checking while the classifier runs and restores the status after", async () => {
	let release!: () => void;
	const gate = new Promise<void>((resolve) => {
		release = resolve;
	});
	const harness = await setupHookTest({
		classifier: async () => {
			await gate;
			return { decision: "allow", tier: "none", reason: "ok" };
		},
	});
	const pending = harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "echo hi" },
	}, harness.ctx);
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(statusTexts(harness.ctx).at(-1), `${FALLBACK_STATUS_ICON} checking…`);
	release();
	await pending;
	assert.equal(statusTexts(harness.ctx).at(-1), `${FALLBACK_STATUS_ICON} auto`);
});

test("tool_call keeps checking until the last of two concurrent classifier calls finishes", async () => {
	const releases: Array<() => void> = [];
	const harness = await setupHookTest({
		classifier: () => new Promise((resolve) => {
			releases.push(() => resolve({ decision: "allow", tier: "none", reason: "ok" }));
		}),
	});
	const call = () => harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "echo hi" },
	}, harness.ctx);
	const first = call();
	const second = call();
	await new Promise((resolve) => setImmediate(resolve));
	releases[0]!();
	await first;
	assert.equal(statusTexts(harness.ctx).at(-1), `${FALLBACK_STATUS_ICON} checking…`);
	releases[1]!();
	await second;
	assert.equal(statusTexts(harness.ctx).at(-1), `${FALLBACK_STATUS_ICON} auto`);
});

test("tool_call shows the blocked count after a classifier denial", async () => {
	const harness = await setupHookTest({
		classifier: async () => ({ decision: "block", tier: "none", reason: "no" }),
	});
	await harness.emit("tool_call", {
		toolName: "bash",
		input: { command: "echo hi" },
	}, harness.ctx);
	assert.equal(statusTexts(harness.ctx).at(-1), `${FALLBACK_STATUS_ICON} auto · 1 blocked`);
});

// --- observability logging -------------------------------------------------
