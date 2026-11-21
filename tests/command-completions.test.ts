import assert from "node:assert/strict";
import test from "node:test";
import { automodeCompletions } from "../extensions/auto-mode/command-completions.ts";
import { createFakeCtx, createFakePi, baseConfig } from "./test-helpers.ts";
import { createPiAutomode } from "../extensions/auto-mode.ts";

const MODELS = async () => [
	{ selector: "@smol", description: "anthropic/claude-haiku" },
	{ selector: "anthropic/claude-sonnet" },
];

test("the first word completes to subcommands", async () => {
	assert.deepEqual((await automodeCompletions("o", MODELS))?.map((item) => item.value), ["on", "off"]);
	assert.equal((await automodeCompletions("", MODELS))?.length, 10);
	assert.equal(await automodeCompletions("x", MODELS), null);
});

test("model completes to roles and models and keeps the subcommand in the value", async () => {
	assert.deepEqual(await automodeCompletions("model sm", MODELS), [
		{ value: "model @smol", label: "@smol", description: "anthropic/claude-haiku" },
	]);
	assert.equal((await automodeCompletions("model ", MODELS))?.length, 2);
	assert.equal(await automodeCompletions("status x", MODELS), null);
	assert.equal(await automodeCompletions("model a b", MODELS), null);
});

test("/automode registers argument completions", async () => {
	const fake = createFakePi();
	const registered: Array<{ name: string; options: { getArgumentCompletions?: (prefix: string) => unknown } }> = [];
	const registerCommand = fake.pi.registerCommand.bind(fake.pi);
	fake.pi.registerCommand = (name: string, options: never) => {
		registered.push({ name, options });
		registerCommand(name, options);
	};
	createPiAutomode({ loadConfig: () => baseConfig() })(fake.pi);
	await fake.emit("session_start", { type: "session_start" }, createFakeCtx(fake.entries));
	const automode = registered.find(({ name }) => name === "automode");
	const items = await automode?.options.getArgumentCompletions?.("se") as Array<{ value: string }> | null;
	assert.deepEqual(items?.map((item) => item.value), ["settings"]);
});
