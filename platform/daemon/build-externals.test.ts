import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, test } from "bun:test";
import { EXTERNAL_BUN } from "./build-externals";
import { RuntimeManifest } from "./build-manifest/build";

const directories: string[] = [];

afterEach(() => {
	for (const directory of directories.splice(0)) rmSync(directory, { recursive: true, force: true });
});

function fixtureWithDroppedOptionalDependency(): string {
	const directory = mkdtempSync(join(tmpdir(), "signet-daemon-build-"));
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({ name: "optional-native-fixture", optionalDependencies: { "better-sqlite3": "1.0.0" } }),
	);
	directories.push(directory);
	mkdirSync(join(directory, "node_modules"));
	symlinkSync(join(directory, "missing-store", "better-sqlite3"), join(directory, "node_modules", "better-sqlite3"));
	writeFileSync(
		join(directory, "entry.ts"),
		'export async function load() {\n\treturn (await import("better-sqlite3")).default;\n}\n',
	);
	return directory;
}

function buildFixture(directory: string, external: string[]) {
	const manifest = new RuntimeManifest(directory);
	return Bun.build({
		metafile: true,
		plugins: [
			manifest.plugin({
				output: join(directory, "out", "entry.js"),
				directory: join(directory, "out"),
				aliases: {},
				external,
			}),
		],
		entrypoints: [join(directory, "entry.ts")],
		outdir: join(directory, "out"),
		target: "bun",
		format: "esm",
		external,
	}).then((result) => {
		if (!result.metafile) throw new Error("missing build metadata");
		manifest.graph(result.metafile, process.cwd());
		manifest.write(join(directory, "manifest.json"));
		return result;
	});
}

describe("daemon Bun build externals", () => {
	test("does not bundle an ancestor package for a guarded optional import", async () => {
		const outer = mkdtempSync(join(tmpdir(), "signet-ambient-build-"));
		directories.push(outer);
		const directory = join(outer, "workspace");
		const ambient = join(outer, "node_modules", "ambient-optional-fixture");
		mkdirSync(directory);
		mkdirSync(ambient, { recursive: true });
		writeFileSync(
			join(ambient, "package.json"),
			JSON.stringify({ name: "ambient-optional-fixture", version: "1.0.0", main: "index.js" }),
		);
		writeFileSync(join(ambient, "index.js"), 'module.exports = "must not be bundled";');
		writeFileSync(
			join(directory, "package.json"),
			JSON.stringify({ name: "guarded-fixture", optionalDependencies: { "ambient-optional-fixture": "1.0.0" } }),
		);
		writeFileSync(
			join(directory, "entry.ts"),
			'export async function load(){try{return await import("ambient-optional-fixture")}catch{return null}}',
		);
		const result = await buildFixture(directory, []);
		expect(result.success).toBe(true);
		expect(JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"))).toMatchObject({
			optionalAbsent: ["ambient-optional-fixture"],
			files: [],
		});
		rmSync(join(outer, "node_modules"), { recursive: true });
		const built = await import(join(directory, "out", "entry.js"));
		expect(await built.load()).toBeNull();
	});
	test("preserves guarded optional imports and requires without a native external declaration", async () => {
		for (const loader of ["import", "require"]) {
			const directory = fixtureWithDroppedOptionalDependency();
			writeFileSync(
				join(directory, "package.json"),
				JSON.stringify({
					name: "guarded-fixture",
					optionalDependencies: { "absent-optional-native-fixture": "1.0.0" },
				}),
			);
			writeFileSync(
				join(directory, "entry.ts"),
				`export async function load(){try{return await ${loader}("absent-optional-native-fixture")}catch{return null}}`,
			);
			const result = await buildFixture(directory, []);
			expect(result.success).toBe(true);
			expect(JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"))).toMatchObject({
				optionalAbsent: ["absent-optional-native-fixture"],
				files: [],
			});
			const built = await import(join(directory, "out", "entry.js"));
			expect(await built.load()).toBeNull();
		}
	});
	test("rejects invalid metadata instead of classifying an installed optional external as absent", async () => {
		for (const transitive of [false, true]) {
			for (const metadata of ['{"name":', JSON.stringify({ name: "wrong-package", version: "1.0.0" })]) {
				const directory = fixtureWithDroppedOptionalDependency();
				const native = join(directory, "node_modules", "better-sqlite3");
				rmSync(native);
				mkdirSync(native);
				let corrupt = native;
				if (transitive) {
					writeFileSync(
						join(native, "package.json"),
						JSON.stringify({
							name: "better-sqlite3",
							version: "1.0.0",
							main: "index.js",
							optionalDependencies: { "corrupt-optional-fixture": "1.0.0" },
						}),
					);
					writeFileSync(join(native, "index.js"), "module.exports = 42;");
					corrupt = join(native, "node_modules", "corrupt-optional-fixture");
					mkdirSync(corrupt, { recursive: true });
				}
				writeFileSync(join(corrupt, "package.json"), metadata);
				await expect(buildFixture(directory, [...EXTERNAL_BUN])).rejects.toThrow();
			}
		}
	});
	test("still rejects a missing required external dependency during inventory", async () => {
		const directory = fixtureWithDroppedOptionalDependency();
		writeFileSync(
			join(directory, "package.json"),
			JSON.stringify({ name: "required-native-fixture", dependencies: { "better-sqlite3": "1.0.0" } }),
		);
		await expect(buildFixture(directory, [...EXTERNAL_BUN])).rejects.toThrow();
	});
	test("the fixture reproduces a failed optional better-sqlite3 install", async () => {
		const directory = fixtureWithDroppedOptionalDependency();
		await expect(buildFixture(directory, [])).rejects.toThrow();
	});

	test("builds when bun install dropped better-sqlite3 after its native build failed", async () => {
		const directory = fixtureWithDroppedOptionalDependency();
		const result = await buildFixture(directory, [...EXTERNAL_BUN]);
		expect(result.success).toBe(true);
		expect(JSON.parse(readFileSync(join(directory, "manifest.json"), "utf8"))).toMatchObject({
			optionalAbsent: ["better-sqlite3"],
			files: [],
		});
	});
});
