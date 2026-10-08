import { describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { build } from "esbuild";
import { copyManifest } from "./stage-runtime-manifest.mjs";

describe("runtime manifest staging boundary", () => {
	it("copies an arbitrary emitted asset only when its manifest digest matches", async () => {
		const root = mkdtempSync(join(tmpdir(), "runtime-manifest-fixture-"));
		try {
			const src = join(root, "src");
			mkdirSync(src);
			writeFileSync(join(src, "entry.js"), 'import addon from "fixture-native-addon"; export default addon;');
			const built = await build({
				entryPoints: [join(src, "entry.js")],
				bundle: true,
				format: "esm",
				platform: "node",
				external: ["fixture-native-addon"],
				metafile: true,
				write: false,
			});
			expect(
				Object.values(built.metafile.outputs)
					.flatMap((x) => x.imports)
					.some((x) => x.path === "fixture-native-addon" && x.external),
			).toBe(true);
			const bytes = Buffer.from([0, 1, 2, 3, 254]);
			writeFileSync(join(root, "generated.data"), bytes);
			const manifest = join(root, "manifest.json");
			const item = {
				source: "generated.data",
				path: "daemon/dist/generated.data",
				size: bytes.length,
				sha256: createHash("sha256").update(bytes).digest("hex"),
				mode: 0o751,
			};
			writeFileSync(
				manifest,
				JSON.stringify({ version: 1, platform: process.platform, arch: process.arch, files: [item] }),
			);
			const staged = join(root, "stage");
			expect(copyManifest(root, staged, manifest)).toBe(1);
			expect(readFileSync(join(staged, item.path))).toEqual(bytes);
			writeFileSync(join(root, item.source), "stale");
			expect(() => copyManifest(root, staged, manifest)).toThrow("integrity mismatch");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
	it("rejects noncanonical paths and staging-owned metadata destinations", () => {
		const root = mkdtempSync(join(tmpdir(), "runtime-manifest-paths-"));
		try {
			const bytes = Buffer.from("fixture");
			writeFileSync(join(root, "asset.data"), bytes);
			const manifest = join(root, "manifest.json");
			for (const path of [
				"",
				".",
				"./asset.data",
				"dist//asset.data",
				"C:/asset.data",
				"\\server\\asset.data",
				"package.json",
				"runtime-manifest.json",
			]) {
				writeFileSync(
					manifest,
					JSON.stringify({
						version: 1,
						platform: process.platform,
						arch: process.arch,
						files: [
							{
								source: "asset.data",
								path,
								size: bytes.length,
								sha256: createHash("sha256").update(bytes).digest("hex"),
								mode: 0o644,
							},
						],
					}),
				);
				expect(() => copyManifest(root, join(root, "stage"), manifest)).toThrow("Invalid runtime manifest path");
			}
			writeFileSync(
				manifest,
				JSON.stringify({
					version: 1,
					platform: process.platform,
					arch: process.arch,
					files: [{ source: "", path: "dist/asset.data", size: 0, sha256: "", mode: 0o644 }],
				}),
			);
			expect(() => copyManifest(root, join(root, "stage"), manifest)).toThrow("Invalid runtime manifest path");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("rejects a missing required manifest member", () => {
		const root = mkdtempSync(join(tmpdir(), "runtime-manifest-missing-"));
		try {
			const manifest = join(root, "manifest.json");
			writeFileSync(
				manifest,
				JSON.stringify({
					version: 1,
					platform: process.platform,
					arch: process.arch,
					files: [{ source: "absent", path: "dist/generated.native", size: 0, sha256: "", mode: 0o644 }],
				}),
			);
			expect(() => copyManifest(root, join(root, "stage"), manifest)).toThrow("Missing runtime asset");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
