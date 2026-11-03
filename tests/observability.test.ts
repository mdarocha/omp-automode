import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
	buildClassifierActionMessage,
	buildEffectiveConfigFromSources,
	classifyInStages,
	classifyProviderError,
	classifyWithRetry,
	createPiAutomode,
	decisionStage,
	parseRetryAfterMs,
	type ClassifyAction,
	type EffectiveConfig,
} from "../extensions/auto-mode.ts";
import { baseConfig, createFakeCtx, createFakePi } from "./test-helpers.ts";

// Real shape from a 2026-10-17 Anthropic account-limit outage.
const ANTHROPIC_429 =
	'429 {"type":"error","error":{"type":"rate_limit_error","message":"This request would exceed your account\'s rate limit. Please try again later."},"request_id":"req_x"} retry-after-ms=179208000';

function errorResponse(errorMessage: string, stopReason = "error"): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		api: "test",
		provider: "test",
		model: "test",
		usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
		stopReason,
		errorMessage,
		timestamp: Date.now(),
	} as AssistantMessage;
}

const prompt = {
	systemPrompt: "policy",
	contextMessage: { role: "user" as const, content: [{ type: "text" as const, text: "ctx" }], timestamp: 1 },
	actionMessage: buildClassifierActionMessage("action"),
};
const classifier = { model: { provider: "test", id: "x", contextWindow: 200_000, maxTokens: 32_000 } as any };

test("classifyProviderError types real provider failures", () => {
	assert.deepEqual(classifyProviderError(ANTHROPIC_429), { kind: "rate-limit", retryAfterMs: 179_208_000 });
	assert.deepEqual(classifyProviderError("Classifier request timed out after 20000 ms."), { kind: "timeout" });
	assert.deepEqual(classifyProviderError("HTTP 503 service unavailable retry-after=30"), { kind: "server", retryAfterMs: 30_000 });
	assert.deepEqual(classifyProviderError("401 invalid x-api-key"), { kind: "auth" });
	assert.deepEqual(classifyProviderError("Classifier model request was aborted.", "aborted"), { kind: "aborted" });
	assert.deepEqual(classifyProviderError("ECONNRESET"), { kind: "provider" });
	assert.deepEqual(classifyProviderError(undefined, "length"), { kind: "invalid-response" });
});

test("parseRetryAfterMs reads milliseconds and seconds and ignores anything else", () => {
	assert.equal(parseRetryAfterMs("x retry-after-ms=1500"), 1500);
	assert.equal(parseRetryAfterMs("x retry-after: 2"), 2000);
	assert.equal(parseRetryAfterMs("no hint here"), undefined);
});

test("fast-stage provider error response yields a typed failure with stage and retry hint", async () => {
	const decision = await classifyInStages(
		async () => errorResponse(ANTHROPIC_429),
		classifier,
		prompt,
		undefined,
		{ sessionId: "s" },
	);
	assert.equal(decision.decision, "block");
	assert.deepEqual(decision.failure, { kind: "rate-limit", retryAfterMs: 179_208_000, stage: "fast" });
});

test("a thrown timeout is typed at the fast and detailed stages", async () => {
	const timeout = async () => {
		throw new Error("Classifier request timed out after 20000 ms.");
	};
	const fast = await classifyInStages(timeout, classifier, prompt, undefined, { sessionId: "s" });
	assert.deepEqual(fast.failure, { kind: "timeout", stage: "fast" });
	const detailed = await classifyWithRetry(timeout, classifier, { systemPrompt: "s", messages: [] }, undefined);
	assert.deepEqual(detailed.failure, { kind: "timeout", stage: "detailed" });
});

test("a fast answer other than 0 or 1 is an invalid-response failure", async () => {
	const decision = await classifyInStages(
		async () => ({ ...errorResponse(""), content: [{ type: "text", text: "maybe" }], stopReason: "stop", errorMessage: undefined }) as AssistantMessage,
		classifier,
		prompt,
		undefined,
		{ sessionId: "s" },
	);
	assert.deepEqual(decision.failure, { kind: "invalid-response", stage: "fast" });
});

test("a real classifier decision carries no failure", async () => {
	const decision = await classifyInStages(
		async () => ({ ...errorResponse(""), content: [{ type: "text", text: "0" }], stopReason: "stop", errorMessage: undefined }) as AssistantMessage,
		classifier,
		prompt,
		undefined,
		{ sessionId: "s" },
	);
	assert.equal(decision.decision, "allow");
	assert.equal(decision.failure, undefined);
});

test("decisionStage maps kinds to enforcement stages", () => {
	assert.equal(decisionStage("permissions.deny"), "permissions");
	assert.equal(decisionStage("permissions.ask"), "permissions");
	assert.equal(decisionStage("deterministic-hard-deny"), "hard-deny");
	assert.equal(decisionStage("deterministic-path-deny"), "path");
	assert.equal(decisionStage("inside-working-directory"), "inside-cwd");
	assert.equal(decisionStage("permissions.allow"), "allow");
	assert.equal(decisionStage("read-only"), "read-only");
	assert.equal(decisionStage("classifier", "fast"), "classifier-fast");
	assert.equal(decisionStage("classifier", "detailed"), "classifier-detailed");
	assert.equal(decisionStage("classifier"), undefined);
	assert.equal(decisionStage("setup"), undefined);
});

test("config records which scope set enabled", () => {
	assert.equal(buildEffectiveConfigFromSources({}).enabledSource, "default");
	assert.equal(
		buildEffectiveConfigFromSources({ globalSettings: [{ autoMode: { enabled: false } }] }).enabledSource,
		"global",
	);
	assert.equal(
		buildEffectiveConfigFromSources({
			globalSettings: [{ autoMode: { enabled: false } }],
			projectLocalSettings: [{ autoMode: { enabled: true } }],
		}).enabledSource,
		"project-local",
	);
	assert.equal(
		buildEffectiveConfigFromSources({
			globalSettings: [{ autoMode: { enabled: false } }],
			inlineSettings: [{ autoMode: { enabled: true } }],
		}).enabledSource,
		"inline",
	);
	assert.equal(
		buildEffectiveConfigFromSources({ globalSettings: [{ autoMode: { classifierModel: "a/b" } }] }).enabledSource,
		"default",
	);
});

async function startSession(options: {
	config?: EffectiveConfig;
	classifier?: ClassifyAction;
	sessionFile: string;
	agent?: Record<string, unknown>;
	parentSession?: string;
	sessionId?: string;
	hasUI?: boolean;
}) {
	const fake = createFakePi();
	createPiAutomode({
		loadConfig: () => options.config ?? baseConfig({ log: { enabled: true, classifierIo: false } }),
		classifyAction: options.classifier ?? (async () => ({ decision: "allow", tier: "none", reason: "ok" })),
	})(fake.pi);
	const ctx = createFakeCtx(fake.entries, {
		sessionFile: options.sessionFile,
		parentSession: options.parentSession,
		...(options.sessionId ? { sessionId: options.sessionId } : {}),
		...(options.agent ? { agent: options.agent } : {}),
		...(options.hasUI === undefined ? {} : { hasUI: options.hasUI }),
	});
	await fake.emit("session_start", { type: "session_start" }, ctx);
	const status = async () => JSON.parse(
		(await fake.tools.get("automode_inspect")!.execute("c", { action: "status" }, undefined, undefined, ctx)).content[0].text,
	);
	return { ...fake, ctx, status };
}

function readLog(sessionFile: string): any[] {
	return readFileSync(sessionFile.replace(/\.jsonl$/, "-pi-automode.jsonl"), "utf8")
		.trim().split("\n").map((line) => JSON.parse(line));
}

test("decision entries carry duration, stage, agent, and hasUI", async () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-obs-"));
	try {
		const sessionFile = join(dir, "s.jsonl");
		const s = await startSession({
			sessionFile,
			agent: { kind: "sub", id: "Worker", name: "worker", depth: 1 },
			hasUI: false,
		});
		await s.emit("tool_call", { toolName: "read", input: { path: "/tmp/project/a.txt" } }, s.ctx);
		await s.emit("tool_call", { toolName: "bash", input: { command: "npm test" } }, s.ctx);
		const [readEntry, classifierEntry] = readLog(sessionFile);
		assert.equal(readEntry.stage, "read-only");
		assert.equal(classifierEntry.stage, undefined, "stub classifier reports no model stage");
		for (const entry of [readEntry, classifierEntry]) {
			assert.equal(typeof entry.durationMs, "number");
			assert.ok(entry.durationMs >= 0);
			assert.deepEqual(entry.agent, { id: "Worker", name: "worker", kind: "sub" });
			assert.equal(entry.hasUI, false);
			assert.equal("errorKind" in entry, false);
		}
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("decision entries omit agent when the host reports none", async () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-obs-"));
	try {
		const sessionFile = join(dir, "s.jsonl");
		const s = await startSession({ sessionFile });
		await s.emit("tool_call", { toolName: "read", input: { path: "/tmp/project/a.txt" } }, s.ctx);
		const [entry] = readLog(sessionFile);
		assert.equal("agent" in entry, false);
		assert.equal(entry.hasUI, true);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("deterministic stages are logged for hard-deny and permissions.deny", async () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-obs-"));
	try {
		const sessionFile = join(dir, "s.jsonl");
		const s = await startSession({ sessionFile });
		await s.emit("tool_call", { toolName: "bash", input: { command: "rm -rf /" } }, s.ctx);
		const [entry] = readLog(sessionFile);
		assert.equal(entry.kind, "deterministic-hard-deny");
		assert.equal(entry.stage, "hard-deny");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a fail-closed classifier block logs errorKind, retryAfterMs, and stage", async () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-obs-"));
	try {
		const sessionFile = join(dir, "s.jsonl");
		const s = await startSession({
			sessionFile,
			config: baseConfig({ classifierModel: "test/classifier", log: { enabled: true, classifierIo: false } }),
			classifier: async () => ({
				decision: "block",
				tier: "none",
				reason: `Fast classifier failed; auto mode fails closed: ${ANTHROPIC_429}`,
				failure: { kind: "rate-limit", stage: "fast", retryAfterMs: 179_208_000 },
			}),
		});
		await s.emit("tool_call", { toolName: "bash", input: { command: "npm test" } }, s.ctx);
		const [entry] = readLog(sessionFile);
		assert.equal(entry.outcome, "block");
		assert.equal(entry.kind, "classifier");
		assert.equal(entry.stage, "classifier-fast");
		assert.equal(entry.errorKind, "rate-limit");
		assert.equal(entry.retryAfterMs, 179_208_000);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("a classifier denial is not a failure", async () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-obs-"));
	try {
		const sessionFile = join(dir, "s.jsonl");
		const s = await startSession({
			sessionFile,
			classifier: async () => ({ decision: "block", tier: "soft_deny", reason: "denied" }),
		});
		await s.emit("tool_call", { toolName: "bash", input: { command: "npm publish" } }, s.ctx);
		const [entry] = readLog(sessionFile);
		assert.equal("errorKind" in entry, false);
		assert.equal((await s.status()).state.recentClassifierErrors.length, 0);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("inspect status reports last decision kind without the reason", async () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-obs-"));
	try {
		const s = await startSession({
			sessionFile: join(dir, "s.jsonl"),
			classifier: async () => ({ decision: "block", tier: "soft_deny", reason: "SECRET-REASON" }),
		});
		await s.emit("tool_call", { toolName: "bash", input: { command: "npm publish" } }, s.ctx);
		const status = await s.status();
		assert.equal(status.state.lastDecision, "block");
		assert.equal(status.state.lastDecisionKind, "classifier");
		assert.match(status.status, /last decision kind: classifier/);
		assert.doesNotMatch(JSON.stringify(status), /SECRET-REASON/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("inspect status lists recent classifier errors without payloads", async () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-obs-"));
	try {
		const failures = [
			{ kind: "timeout", stage: "fast" },
			{ kind: "rate-limit", stage: "detailed", retryAfterMs: 60_000 },
		] as const;
		let call = 0;
		const s = await startSession({
			sessionFile: join(dir, "s.jsonl"),
			config: baseConfig({ classifierModel: "test/haiku", log: { enabled: true, classifierIo: false } }),
			classifier: async () => ({
				decision: "block",
				tier: "none",
				reason: `PROVIDER-PAYLOAD ${ANTHROPIC_429}`,
				failure: failures[call++],
			}),
		});
		await s.emit("tool_call", { toolName: "bash", input: { command: "npm test" } }, s.ctx);
		await s.emit("tool_call", { toolName: "bash", input: { command: "npm test" } }, s.ctx);
		const status = await s.status();
		const errors = status.state.recentClassifierErrors;
		assert.equal(errors.length, 2);
		assert.deepEqual(
			errors.map((error: any) => [error.kind, error.stage, error.retryAfterMs, error.model]),
			[["rate-limit", "detailed", 60_000, "test/haiku"], ["timeout", "fast", undefined, "test/haiku"]],
		);
		assert.equal(typeof errors[0].timestamp, "number");
		assert.doesNotMatch(JSON.stringify(status), /PROVIDER-PAYLOAD|req_x/);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("recent classifier errors persist across session restore and stay bounded", async () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-obs-"));
	try {
		const s = await startSession({
			sessionFile: join(dir, "s.jsonl"),
			classifier: async () => ({
				decision: "block", tier: "none", reason: "failed", failure: { kind: "server", stage: "fast" },
			}),
		});
		for (let i = 0; i < 15; i += 1) {
			await s.emit("tool_call", { toolName: "bash", input: { command: "npm test" } }, s.ctx);
		}
		const persisted = s.entries.at(-1)!.data;
		assert.equal(persisted.recentClassifierErrors.length, 12);
		const restored = await startSession({ sessionFile: join(dir, "s.jsonl") });
		restored.entries.push(...s.entries);
		await restored.emit("session_start", { type: "session_start" }, restored.ctx);
		assert.equal((await restored.status()).state.recentClassifierErrors.length, 12);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("inspect status reports enabled source, agent identity, and hasUI", async () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-obs-"));
	try {
		const main = await startSession({
			sessionFile: join(dir, "main.jsonl"),
			agent: { kind: "main", id: "Main", name: "main", depth: 0 },
			config: baseConfig({ enabledSource: "global" }),
		});
		let status = await main.status();
		assert.equal(status.enabledSource, "global");
		assert.deepEqual(status.agent, { kind: "main", id: "Main", name: "main", depth: 0 });
		assert.equal(status.hasUI, true);

		await main.commands.get("automode")!.handler("off", main.ctx);
		await main.commands.get("automode")!.handler("on", main.ctx);
		status = await main.status();
		assert.equal(status.enabledSource, "override");

		const sub = await startSession({
			sessionFile: join(dir, "main", "Worker.jsonl"),
			parentSession: join(dir, "main.jsonl"),
			sessionId: "worker-session",
			agent: { kind: "sub", id: "Worker", name: "worker", depth: 1 },
			hasUI: false,
		});
		status = await sub.status();
		assert.equal(status.enabledSource, "parent");
		assert.equal(status.agent.id, "Worker");
		assert.equal(status.hasUI, false);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});

test("inspect status omits agent when the host has no agent identity", async () => {
	const dir = mkdtempSync(join(os.tmpdir(), "pi-automode-obs-"));
	try {
		const s = await startSession({ sessionFile: join(dir, "s.jsonl") });
		const status = await s.status();
		assert.equal(status.agent, undefined);
		assert.equal(status.enabledSource, "default");
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
