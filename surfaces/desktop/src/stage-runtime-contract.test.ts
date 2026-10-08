import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { copyManifest } from "../scripts/stage-runtime-manifest.mjs";

test("the stage copier rejects an incomplete runtime inventory before staging", () => {
	const root = mkdtempSync(join(tmpdir(), "desktop-runtime-boundary-"));
	try {
		const source = join(root, "source");
		const destination = join(root, "resources");
		mkdirSync(source);
		mkdirSync(destination);
		const manifest = join(root, "manifest.json");
		writeFileSync(
			manifest,
			JSON.stringify({
				version: 1,
				platform: process.platform,
				arch: process.arch,
				files: [{ source: "dist/daemon.js", path: "dist/daemon.js", size: 1, sha256: "0".repeat(64), mode: 0o644 }],
			}),
		);
		expect(() => copyManifest(source, destination, manifest)).toThrow("Missing runtime asset");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
