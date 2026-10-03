import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, chmodSync, existsSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { tmpdir } from "node:os";
import { RuntimeManifest } from "./build";

function fixturePackage(
	root: string,
	name: string,
	version: string,
	source: string,
	dependencies: Record<string, string> = {},
	peers: Record<string, string> = {},
): string {
	const directory = join(root, ...name.split("/"));
	mkdirSync(directory, { recursive: true });
	writeFileSync(
		join(directory, "package.json"),
		JSON.stringify({ name, version, main: "index.js", dependencies, peerDependencies: peers }),
	);
	writeFileSync(join(directory, "index.js"), source);
	return directory;
}

async function buildFixture(root: string, entry: string, manifest: RuntimeManifest): Promise<string> {
	const output = join(root, "dist");
	const result = await Bun.build({
		entrypoints: [entry],
		outdir: output,
		naming: { entry: "entry.js" },
		target: "bun",
		format: "esm",
		plugins: [
			{
				name: "runtime-manifest-externalization",
				setup(build) {
					build.onResolve({ filter: /^[^./]/ }, ({ path, importer }) => {
						if (!importer) return undefined;
						const resolved = manifest.external(path, importer);
						return resolved ? { path: resolved, external: true } : undefined;
					});
				},
			},
		],
	});
	expect(result.success).toBe(true);
	return join(output, "entry.js");
}

function installFixture(root: string, installed: string, builtEntry: string, manifest: RuntimeManifest): void {
	manifest.add(builtEntry, "dist/entry.js");
	manifest.materialize(installed);
	const inventory = join(root, "inventory.json");
	manifest.write(inventory);
}

describe("RuntimeManifest", () => {
	test("inventories external package bytes and verifies worker references, hashes and modes", () => {
		const root = mkdtempSync(join(tmpdir(), "runtime-manifest-"));
		try {
			const fixture = join(root, "fixture");
			const pkg = join(root, "node_modules", "native-fixture");
			mkdirSync(fixture, { recursive: true });
			writeFileSync(
				join(fixture, "package.json"),
				JSON.stringify({ name: "runtime-fixture", private: true, dependencies: { "native-fixture": "1.0.0" } }),
			);
			mkdirSync(join(pkg, "prebuilds", "linux-x64"), { recursive: true });
			writeFileSync(
				join(fixture, "entry.js"),
				'import "native-fixture"; export const worker = new Worker(new URL("./worker.js", import.meta.url));',
			);
			writeFileSync(join(fixture, "worker.js"), "postMessage('ok');");
			writeFileSync(join(fixture, "asset.wasm"), Buffer.from([0, 97, 115, 109]));
			writeFileSync(
				join(pkg, "package.json"),
				JSON.stringify({ name: "native-fixture", version: "1.0.0", main: "index.js" }),
			);
			writeFileSync(join(pkg, "index.js"), 'module.exports = require("./prebuilds/linux-x64/addon.node");');
			writeFileSync(join(pkg, "prebuilds/linux-x64/addon.node"), Buffer.from([0, 1, 2, 3]));
			chmodSync(join(pkg, "prebuilds/linux-x64/addon.node"), 0o751);
			const manifest = new RuntimeManifest(root);
			manifest.add(join(fixture, "asset.wasm"), "daemon/dist/vendor/asset.wasm");
			manifest.graph(
				{
					inputs: {
						"fixture/entry.js": { imports: [{ path: "native-fixture", external: true }] },
						"fixture/worker.js": { imports: [] },
					},
				},
				root,
			);
			const output = join(root, "manifest.json");
			manifest.write(output);
			const value = JSON.parse(readFileSync(output, "utf8"));
			expect(value.files.map((file: { path: string }) => file.path)).toEqual(
				expect.arrayContaining([
					"daemon/dist/vendor/asset.wasm",
					"node_modules/native-fixture/package.json",
					"node_modules/native-fixture/index.js",
					"node_modules/native-fixture/prebuilds/linux-x64/addon.node",
				]),
			);
			const native = value.files.find((file: { path: string }) => file.path.endsWith("addon.node"));
			expect(native.size).toBe(4);
			expect(native.sha256).toMatch(/^[a-f0-9]{64}$/);
			expect(native.mode).toBe(statSync(join(pkg, "prebuilds/linux-x64/addon.node")).mode & 0o777);
			expect(manifest.graph({ inputs: { "fixture/entry.js": { imports: [] } } }, root)).toContain("worker.js");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects missing assets and conflicting bytes at the same destination", () => {
		const root = mkdtempSync(join(tmpdir(), "runtime-manifest-invalid-"));
		try {
			const a = join(root, "a");
			const b = join(root, "b");
			writeFileSync(a, "first");
			writeFileSync(b, "second");
			const manifest = new RuntimeManifest(root);
			expect(() => manifest.add(join(root, "missing"), "missing")).toThrow("Missing runtime asset");
			manifest.add(a, "same");
			expect(() => manifest.add(b, "same")).toThrow("Conflicting runtime asset");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("executes isolated incompatible transitive versions from the relocated build", async () => {
		const root = mkdtempSync(join(tmpdir(), "runtime-manifest-versions-"));
		try {
			const modules = join(root, "node_modules");
			const app = join(root, "app");
			mkdirSync(app, { recursive: true });
			const left = fixturePackage(modules, "left", "1.0.0", 'module.exports = require("shared");', { shared: "1" });
			const right = fixturePackage(modules, "right", "1.0.0", 'module.exports = require("shared");', { shared: "2" });
			fixturePackage(join(left, "node_modules"), "shared", "1.0.0", 'module.exports = "one";');
			fixturePackage(join(right, "node_modules"), "shared", "2.0.0", 'module.exports = "two";');
			const entry = join(app, "entry.js");
			writeFileSync(entry, 'console.log(JSON.stringify([require("left"), require("right")]));');
			const manifest = new RuntimeManifest(root);
			const installed = join(root, "installed");
			installFixture(root, installed, await buildFixture(root, entry, manifest), manifest);
			rmSync(join(root, "node_modules"), { recursive: true });
			const run = Bun.spawnSync([process.execPath, join(installed, "dist/entry.js")], {
				cwd: installed,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(run.exitCode).toBe(0);
			expect(run.stdout.toString().trim()).toBe('["one","two"]');
			const inventory = JSON.parse(readFileSync(join(root, "inventory.json"), "utf8"));
			const sharedPaths = inventory.files
				.map((file: { path: string }) => file.path)
				.filter((path: string) => /\/node_modules\/shared\//.test(path));
			expect(sharedPaths.length).toBe(4);
			expect(new Set(sharedPaths.map((path: string) => path.split("/node_modules/shared/")[0])).size).toBe(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("executes a relocated external package with a sibling unfamiliar-extension runtime asset", async () => {
		const root = mkdtempSync(join(tmpdir(), "runtime-manifest-asset-"));
		try {
			const app = join(root, "app");
			mkdirSync(app, { recursive: true });
			const pkg = fixturePackage(
				join(root, "node_modules"),
				"asset-fixture",
				"1.0.0",
				'const fs = require("node:fs"); module.exports = fs.readFileSync(__dirname + "/payload.data", "utf8");',
			);
			writeFileSync(join(pkg, "payload.data"), "asset survived relocation");
			const entry = join(app, "entry.js");
			writeFileSync(entry, 'console.log(require("asset-fixture"));');
			const manifest = new RuntimeManifest(root);
			const installed = join(root, "installed");
			installFixture(root, installed, await buildFixture(root, entry, manifest), manifest);
			rmSync(join(root, "node_modules"), { recursive: true });
			const run = Bun.spawnSync([process.execPath, join(installed, "dist/entry.js")], {
				cwd: installed,
				stdout: "pipe",
				stderr: "pipe",
			});
			expect(run.exitCode).toBe(0);
			expect(run.stdout.toString().trim()).toBe("asset survived relocation");
			const inventory = JSON.parse(readFileSync(join(root, "inventory.json"), "utf8"));
			expect(
				inventory.files.some((file: { source: string }) => file.source === `${relative(root, pkg)}/payload.data`),
			).toBe(true);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test.skipIf(process.platform !== "linux" || !existsSync("/usr/include/node/node_api.h"))(
		"loads a compiled NAPI dependency after relocation and rejects a missing installed addon",
		async () => {
			const root = mkdtempSync(join(tmpdir(), "runtime-manifest-napi-"));
			try {
				const pkg = fixturePackage(
					join(root, "node_modules"),
					"compiled-addon",
					"1.0.0",
					'module.exports = require("./addon.node").answer();',
				);
				const source = join(pkg, "addon.c");
				writeFileSync(
					source,
					`#include <node_api.h>
static napi_value answer(napi_env env, napi_callback_info info) {
  napi_value value;
  napi_create_uint32(env, 42, &value);
  return value;
}
static napi_value init(napi_env env, napi_value exports) {
  napi_value function;
  napi_create_function(env, "answer", NAPI_AUTO_LENGTH, answer, NULL, &function);
  napi_set_named_property(env, exports, "answer", function);
  return exports;
}
NAPI_MODULE(fixture, init)
`,
				);
				const compiled = Bun.spawnSync(
					["cc", "-shared", "-fPIC", "-I/usr/include/node", source, "-o", join(pkg, "addon.node")],
					{ stdout: "pipe", stderr: "pipe" },
				);
				expect(compiled.exitCode, compiled.stderr.toString()).toBe(0);
				const entry = join(root, "entry.js");
				writeFileSync(entry, 'console.log(require("compiled-addon"));');
				const manifest = new RuntimeManifest(root);
				const installed = join(root, "installed");
				installFixture(root, installed, await buildFixture(root, entry, manifest), manifest);
				rmSync(join(root, "node_modules"), { recursive: true });
				const executed = Bun.spawnSync([process.execPath, join(installed, "dist/entry.js")], {
					cwd: installed,
					stdout: "pipe",
					stderr: "pipe",
				});
				expect(executed.exitCode, executed.stderr.toString()).toBe(0);
				expect(executed.stdout.toString().trim()).toBe("42");
				const inventory = JSON.parse(readFileSync(join(root, "inventory.json"), "utf8"));
				const addon = inventory.files.find((file: { path: string }) => file.path.endsWith("/addon.node"));
				rmSync(join(installed, addon.path));
				const missing = Bun.spawnSync([process.execPath, join(installed, "dist/entry.js")], {
					cwd: installed,
					stdout: "pipe",
					stderr: "pipe",
				});
				expect(missing.exitCode).not.toBe(0);
				expect(missing.stderr.toString()).toContain("addon.node");
			} finally {
				rmSync(root, { recursive: true, force: true });
			}
		},
	);

	test("terminates on cyclic dependency and peer declarations without graph growth", () => {
		const root = mkdtempSync(join(tmpdir(), "runtime-manifest-cycle-"));
		try {
			const a = fixturePackage(
				join(root, "node_modules"),
				"cycle-a",
				"1.0.0",
				"module.exports = 1;",
				{ "cycle-b": "*" },
				{ "cycle-b": "*" },
			);
			fixturePackage(
				join(a, "node_modules"),
				"cycle-b",
				"1.0.0",
				"module.exports = 2;",
				{ "cycle-a": "*" },
				{ "cycle-a": "*" },
			);
			const manifest = new RuntimeManifest(root);
			const started = Date.now();
			manifest.dependency("cycle-a", join(root, "entry.js"));
			expect(Date.now() - started).toBeLessThan(2_000);
			const inventory = join(root, "inventory.json");
			manifest.write(inventory);
			expect(JSON.parse(readFileSync(inventory, "utf8")).files.length).toBeLessThan(20);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
