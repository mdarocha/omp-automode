import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import { join, relative } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	deniedGrepResultFiles,
	deniedSearchExclusions,
	matchesDeniedPath,
	narrowGrepSearch,
} from "../extensions/auto-mode.ts";

/** Reference matcher for the glob syntax the exclusions use: a leading `**` component, `*`, and one-character classes. */
function globToRegExp(glob: string): RegExp {
	let source = "";
	let rest = glob;
	if (rest.startsWith("**/")) {
		source += "(?:.*/)?";
		rest = rest.slice(3);
	}
	for (let index = 0; index < rest.length; index += 1) {
		const character = rest[index]!;
		if (character === "*") {
			source += "[^/]*";
		} else if (character === "[") {
			const end = rest.indexOf("]", index + 2);
			const body = rest.slice(index + 1, end);
			source += `[${body.replace(/[\\\]^-]/g, "\\$&")}]`;
			index = end;
		} else {
			source += character.replace(/[.+?^${}()|\\/]/g, "\\$&");
		}
	}
	return new RegExp(`^${source}$`);
}

/** A matched file or directory drops its whole subtree, as in OMP's native grep. */
function isExcluded(relativePath: string, exclusions: string[]): boolean {
	const matchers = exclusions.map((entry) => globToRegExp(entry.slice(1)));
	const parts = relativePath.split("/");
	return parts.some((_, index) => {
		const prefix = parts.slice(0, index + 1).join("/");
		return matchers.some((matcher) => matcher.test(prefix));
	});
}

const FILES = [
	"README.md",
	"src/app.ts",
	"src/.env",
	"src/deep/er/.env",
	"src/deep/config.env",
	"src/keys/id_rsa",
	"src/keys/id_rsa.pub",
	"src/keys/nested/id_ed25519",
	"private/token.txt",
	"private/sub/other.txt",
	"docs/My Notes/secret [1].txt",
	"docs/My Notes/plain.txt",
	"docs/Café/note.txt",
	"vendor/.ENV",
];

function makeTree(t: test.TestContext): string {
	const base = realpathSync(mkdtempSync(join(os.tmpdir(), "pi-automode-scope-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	for (const file of FILES) {
		mkdirSync(join(base, file, ".."), { recursive: true });
		writeFileSync(join(base, file), "needle");
	}
	return base;
}

test("exclusions drop every denied file and keep unrelated ones searchable", (t) => {
	const base = makeTree(t);
	const cases: { denied: string[]; kept: string[] }[] = [
		{ denied: [`${base}/private/token.txt`], kept: ["README.md", "private/sub/other.txt"] },
		{ denied: ["*.env"], kept: ["README.md", "src/app.ts", "src/keys/id_rsa"] },
		{ denied: [`${base}/src/keys/id_*`], kept: ["src/app.ts", "src/.env"] },
		{ denied: [`${base}/*/id_rsa`], kept: ["src/app.ts", "private/token.txt"] },
		{ denied: ["**/id_rsa"], kept: ["src/app.ts", "src/keys/id_rsa.pub"] },
		{ denied: [`${base}/docs/My Notes/secret [1].txt`], kept: ["docs/My Notes/plain.txt"] },
		{ denied: [`${base}/docs/Caf\u00e9/*`], kept: ["README.md"] },
		{ denied: [`${base}/src/.ENV`], kept: ["README.md", "src/app.ts"] },
	];
	for (const { denied, kept } of cases) {
		const exclusions = deniedSearchExclusions([base], denied);
		assert.ok(exclusions, JSON.stringify(denied));
		for (const file of FILES) {
			if (matchesDeniedPath(join(base, file), denied)) {
				assert.equal(isExcluded(file, exclusions), true, `${file} must be excluded for ${JSON.stringify(denied)}`);
			}
		}
		for (const file of kept) {
			assert.equal(isExcluded(file, exclusions), false, `${file} must stay searchable for ${JSON.stringify(denied)}`);
		}
	}
});

test("exclusions are empty when no denied path can lie under the root", (t) => {
	const base = makeTree(t);
	assert.deepEqual(deniedSearchExclusions([base], ["/etc/*", "~/.ssh/*", join(os.tmpdir(), "elsewhere", "*")]), []);
	// A pattern ending in `/` matches no file.
	assert.deepEqual(deniedSearchExclusions([base], [`${base}/private/*/`]), []);
});

test("exclusions cover both the typed and the symlink-resolved root", (t) => {
	const base = makeTree(t);
	const exclusions = deniedSearchExclusions(["/some/link", base], [`${base}/private/token.txt`]);
	assert.ok(exclusions);
	assert.equal(isExcluded("private/token.txt", exclusions), true);
});

test("a pattern that matches the whole tree or cannot be written cannot be excluded", (t) => {
	const base = makeTree(t);
	for (const denied of [
		`${base}/*`,
		`${os.tmpdir()}/*`,
		"*",
		`${base}/a{b}/c`,
		`${base}/semi;colon`,
	]) {
		assert.equal(deniedSearchExclusions([base], [denied]), undefined, denied);
	}
});

test("narrowGrepSearch appends exclusions as a path list entry", (t) => {
	const base = makeTree(t);
	const denied = [`${base}/private/token.txt`];
	const exclusions = deniedSearchExclusions([base], denied) ?? [];
	assert.notEqual(exclusions.length, 0);

	const narrowed = narrowGrepSearch({ pattern: "needle", path: "." }, base, denied);
	assert.ok(narrowed);
	assert.equal(narrowed.pattern, "needle");
	assert.equal(narrowed.path, [".", ...exclusions].join(";"));
});

test("narrowGrepSearch handles omitted, JSON-array and glob paths", (t) => {
	const base = makeTree(t);
	const denied = [`${base}/private/token.txt`];
	const exclusions = deniedSearchExclusions([base], denied) ?? [];

	assert.equal(narrowGrepSearch({ pattern: "x" }, base, denied)?.path, [".", ...exclusions].join(";"));
	assert.equal(
		narrowGrepSearch({ pattern: "x", path: '["."]' }, base, denied)?.path,
		JSON.stringify([".", ...exclusions]),
	);
	// Exclusions are relative to the walked base of a glob path (`private`).
	const privateExclusions = deniedSearchExclusions([join(base, "private")], denied) ?? [];
	assert.deepEqual(privateExclusions.map((entry) => globToRegExp(entry.slice(1)).test("token.txt")), [true]);
	assert.equal(
		narrowGrepSearch({ pattern: "x", path: "private/**/*.txt" }, base, denied)?.path,
		["private/**/*.txt", ...privateExclusions].join(";"),
	);
	assert.equal(
		narrowGrepSearch({ pattern: "x", path: "src;." }, base, denied)?.path,
		["src;.", ...exclusions].join(";"),
	);
});

test("narrowGrepSearch fails closed when it cannot guarantee the exclusions", (t) => {
	const base = makeTree(t);
	const denied = [`${base}/private/token.txt`];
	// Unbalanced brace or backslash: an appended `;` entry would not be split off.
	assert.equal(narrowGrepSearch({ pattern: "x", path: "src/{a" }, base, denied), undefined);
	assert.equal(narrowGrepSearch({ pattern: "x", path: "src\\;x" }, base, denied), undefined);
	// A URL root does not name a local directory.
	assert.equal(narrowGrepSearch({ pattern: "x", path: "https://example.com;." }, base, denied), undefined);
	// Everything under the root is denied.
	assert.equal(narrowGrepSearch({ pattern: "x", path: "." }, base, [`${base}/*`]), undefined);
});

test("deniedGrepResultFiles lists denied files and rejects unknown result shapes", (t) => {
	const base = makeTree(t);
	const denied = [`${base}/private/token.txt`, "*.env"];
	assert.deepEqual(
		deniedGrepResultFiles({ files: ["README.md", "private/token.txt", "src/deep/config.env"] }, base, denied),
		["private/token.txt", "src/deep/config.env"],
	);
	assert.deepEqual(deniedGrepResultFiles({ files: [relative(base, join(base, "README.md"))] }, base, denied), []);
	assert.deepEqual(deniedGrepResultFiles({ files: [join(base, "private", "token.txt")] }, "/elsewhere", denied), [
		join(base, "private", "token.txt"),
	]);
	for (const details of [undefined, null, {}, { files: "README.md" }, { files: [1] }, "text"]) {
		assert.equal(deniedGrepResultFiles(details, base, denied), undefined, JSON.stringify(details));
	}
});
