import {
	mkdirSync,
	mkdtempSync,
	realpathSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import os from "node:os";
import { join } from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import {
	buildEffectiveConfigFromSources,
	isInsideReadOnlyRoot,
	loadEffectiveConfigWithDiagnostics,
	readOnlyRootProblem,
	validateSettingsFile,
} from "../extensions/auto-mode.ts";

const HOME = os.homedir();

test("allowReadOnlyBash defaults to false and readOnlyRoots defaults to empty", () => {
	const config = buildEffectiveConfigFromSources({});
	assert.equal(config.allowReadOnlyBash, false);
	assert.deepEqual(config.readOnlyRoots, []);
});

test("allowReadOnlyBash and readOnlyRoots merge from user-owned settings", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { allowReadOnlyBash: true, readOnlyRoots: ["/tmp", "~/.omp/wt"] } }],
		projectLocalSettings: [{ autoMode: { readOnlyRoots: ["/nix/store"] } }],
		inlineSettings: [{ autoMode: { readOnlyRoots: ["$HOME/scratch"] } }],
	});

	assert.equal(config.allowReadOnlyBash, true);
	assert.deepEqual(config.readOnlyRoots, ["/tmp", "~/.omp/wt", "/nix/store", "$HOME/scratch"]);
});

test("a later source can switch allowReadOnlyBash off again", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { allowReadOnlyBash: true } }],
		inlineSettings: [{ autoMode: { allowReadOnlyBash: false } }],
	});
	assert.equal(config.allowReadOnlyBash, false);
});

test("$defaults in readOnlyRoots is a no-op and replacement works like other rule lists", () => {
	const config = buildEffectiveConfigFromSources({
		globalSettings: [{ autoMode: { readOnlyRoots: ["$defaults", "/tmp"] } }],
	});
	assert.deepEqual(config.readOnlyRoots, ["/tmp"]);
});

test("shared project settings cannot enable allowReadOnlyBash or readOnlyRoots", () => {
	const config = buildEffectiveConfigFromSources({
		projectSharedSettings: [
			{ autoMode: { allowReadOnlyBash: true, readOnlyRoots: ["/tmp"] } },
		],
	});

	assert.equal(config.allowReadOnlyBash, false);
	assert.deepEqual(config.readOnlyRoots, []);
});

test("project-local and shared files load through the real config loader with the same rule", (t) => {
	const project = mkdtempSync(join(os.tmpdir(), "pi-automode-ro-config-"));
	t.after(() => rmSync(project, { recursive: true, force: true }));
	mkdirSync(join(project, ".pi"), { recursive: true });
	writeFileSync(
		join(project, ".pi/automode.json"),
		JSON.stringify({ autoMode: { allowReadOnlyBash: true, readOnlyRoots: ["/tmp"] } }),
	);

	const shared = loadEffectiveConfigWithDiagnostics(project, true);
	assert.equal(shared.config.allowReadOnlyBash, false);
	assert.deepEqual(shared.config.readOnlyRoots, []);

	writeFileSync(
		join(project, ".pi/automode.local.json"),
		JSON.stringify({ autoMode: { allowReadOnlyBash: true, readOnlyRoots: ["/tmp"] } }),
	);
	const local = loadEffectiveConfigWithDiagnostics(project, true);
	assert.equal(local.config.allowReadOnlyBash, true);
	assert.deepEqual(local.config.readOnlyRoots, ["/tmp"]);

	const untrusted = loadEffectiveConfigWithDiagnostics(project, false);
	assert.equal(untrusted.config.allowReadOnlyBash, false);
	assert.deepEqual(untrusted.config.readOnlyRoots, []);
});

test("validateSettingsFile rejects a non-boolean allowReadOnlyBash and a non-array readOnlyRoots", () => {
	const diagnostics = validateSettingsFile(
		{ autoMode: { allowReadOnlyBash: "yes", readOnlyRoots: "/tmp" } },
		"test",
	);
	assert.ok(diagnostics.some((line) => /allowReadOnlyBash must be a boolean/.test(line)));
	assert.ok(diagnostics.some((line) => /readOnlyRoots must be an array of strings/.test(line)));
});

test("validateSettingsFile accepts valid readOnlyRoots", () => {
	assert.deepEqual(
		validateSettingsFile(
			{ autoMode: { allowReadOnlyBash: true, readOnlyRoots: ["/tmp", "/nix/store", "~/.omp/wt", "$HOME/scratch", "/var/tmp/", "$defaults"] } },
			"test",
		),
		[],
	);
});

const INVALID_ROOTS: Array<[unknown, RegExp]> = [
	["", /non-empty absolute path/],
	["   ", /non-empty absolute path/],
	[42, /non-empty absolute path/],
	["relative/dir", /absolute path/],
	["./scratch", /absolute path/],
	["scratch", /absolute path/],
	["/", /filesystem root, the home directory, or a system root/],
	["//", /filesystem root, the home directory, or a system root/],
	["~", /filesystem root, the home directory, or a system root/],
	["$HOME", /filesystem root, the home directory, or a system root/],
	["${HOME}", /filesystem root, the home directory, or a system root/],
	[`${HOME}/`, /filesystem root, the home directory, or a system root/],
	[HOME, /filesystem root, the home directory, or a system root/],
	["/etc", /filesystem root, the home directory, or a system root/],
	["/etc/ssh", /filesystem root, the home directory, or a system root/],
	["/usr", /filesystem root, the home directory, or a system root/],
	["/home", /filesystem root, the home directory, or a system root/],
	["/Users", /filesystem root, the home directory, or a system root/],
	["/var", /filesystem root, the home directory, or a system root/],
	["/proc", /filesystem root, the home directory, or a system root/],
	["/proc/self", /filesystem root, the home directory, or a system root/],
	["/sys/kernel", /filesystem root, the home directory, or a system root/],
	["/dev/shm", /filesystem root, the home directory, or a system root/],
	["/root", /filesystem root, the home directory, or a system root/],
	["/tmp/*", /wildcards/],
	["/tmp/../etc", /"\.\." segments/],
	["~/../..", /"\.\." segments/],
	["/tmp/a/../..", /"\.\." segments/],
];

test("validateSettingsFile flags unsafe readOnlyRoots entries and the config drops them", () => {
	for (const [entry, expected] of INVALID_ROOTS) {
		const diagnostics = validateSettingsFile({ autoMode: { readOnlyRoots: [entry] } }, "test");
		assert.ok(
			diagnostics.some((line) => expected.test(line)),
			`${JSON.stringify(entry)} should be flagged: ${JSON.stringify(diagnostics)}`,
		);
		if (typeof entry === "string") {
			const config = buildEffectiveConfigFromSources({
				globalSettings: [{ autoMode: { readOnlyRoots: [entry, "/tmp"] } }],
			});
			assert.deepEqual(config.readOnlyRoots, ["/tmp"], `${JSON.stringify(entry)} must be dropped`);
		}
	}
});

test("readOnlyRootProblem accepts scratch directories", () => {
	for (const entry of ["/tmp", "/tmp/", "/nix/store", "~/.omp/wt", "$HOME/projects", "/var/tmp", "/mnt/scratch", "/opt/data"]) {
		assert.equal(readOnlyRootProblem(entry), undefined, entry);
	}
});

test("isInsideReadOnlyRoot compares whole path segments", (t) => {
	const base = realpathSync(mkdtempSync(join(os.tmpdir(), "pi-automode-roots-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const root = join(base, "scratch");
	mkdirSync(join(root, "sub"), { recursive: true });
	mkdirSync(join(base, "scratch-evil"));

	assert.equal(isInsideReadOnlyRoot(root, [root]), true);
	assert.equal(isInsideReadOnlyRoot(join(root, "sub", "file.txt"), [root]), true);
	assert.equal(isInsideReadOnlyRoot(`${root}/`, [`${root}/`]), true);
	assert.equal(isInsideReadOnlyRoot(join(base, "scratch-evil"), [root]), false);
	assert.equal(isInsideReadOnlyRoot(`${root}-evil/file`, [root]), false);
	assert.equal(isInsideReadOnlyRoot(base, [root]), false);
	assert.equal(isInsideReadOnlyRoot(join(root, "sub"), []), false);
	assert.equal(isInsideReadOnlyRoot(join(root, "sub"), ["relative/dir", "/etc", "/"]), false);
	assert.equal(isInsideReadOnlyRoot(join(root, "sub"), [join(base, "other"), root]), true);
	assert.equal(isInsideReadOnlyRoot(root.toUpperCase(), [root]), false);
});

test("isInsideReadOnlyRoot resolves a symlinked root and refuses one that resolves to a protected location", (t) => {
	const base = realpathSync(mkdtempSync(join(os.tmpdir(), "pi-automode-roots-")));
	t.after(() => rmSync(base, { recursive: true, force: true }));
	const real = join(base, "real");
	mkdirSync(real);
	const link = join(base, "link");
	symlinkSync(real, link);
	const toHome = join(base, "to-home");
	symlinkSync(HOME, toHome);
	const toEtc = join(base, "to-etc");
	symlinkSync("/etc", toEtc);

	// Callers pass symlink-resolved policy paths, so the real path is inside the symlinked root.
	assert.equal(isInsideReadOnlyRoot(join(real, "file"), [link]), true);
	assert.equal(isInsideReadOnlyRoot(join(HOME, "file"), [toHome]), false);
	assert.equal(isInsideReadOnlyRoot("/etc/passwd", [toEtc]), false);
	assert.equal(isInsideReadOnlyRoot(join(HOME, ".ssh", "id_rsa"), [toHome]), false);
});
