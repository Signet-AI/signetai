import { describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	mergeMacUpdateManifests,
	parseUpdateManifest,
	renderUpdateManifest,
	validateMergedMacUpdateManifest,
} from "./merge-mac-update-manifest";

const x64Manifest = `version: 0.230.6
files:
  - url: Signet-0.230.6-mac-x64.zip
    sha512: eOiUv2AhQiyijwNfys7ZuPGZDWuokup+iabTd/Qc4UM3CtTXOZow//CDrTpP7559ffAiSv+pLLCEWZFzuBrA+Q==
    size: 201851314
  - url: Signet-0.230.6-mac-x64.dmg
    sha512: oHSkgl8SeoWeqDOI20rb2d1nYx4NJ+srGolPm1Tw1xUJBDypb7kMJOmPyIs5p8y+J/wo6dXKHcvmjg55Iv98UA==
    size: 202550452
path: Signet-0.230.6-mac-x64.zip
sha512: eOiUv2AhQiyijwNfys7ZuPGZDWuokup+iabTd/Qc4UM3CtTXOZow//CDrTpP7559ffAiSv+pLLCEWZFzuBrA+Q==
releaseDate: '2026-10-03T07:53:33.572Z'
`;

const arm64Manifest = `version: 0.230.6
files:
  - url: Signet-0.230.6-mac-arm64.zip
    sha512: LOdKHF73q34IbYIXaLwCN1cqxd9ruErOTMqYbpPMRnllqFveCSqzPKSXklOriXZsHvg9jnADdbPOmYlJ2itILQ==
    size: 186557278
  - url: Signet-0.230.6-mac-arm64.dmg
    sha512: eZJIgFNOqdMVgSZcuowc8n61ECwkD2WCZx+/a/ZCD7KS8TFoIevXnBoTDc/BZw3xqhFMw0V+MdEtT8+C4s7wpA==
    size: 187344460
path: Signet-0.230.6-mac-arm64.zip
sha512: LOdKHF73q34IbYIXaLwCN1cqxd9ruErOTMqYbpPMRnllqFveCSqzPKSXklOriXZsHvg9jnADdbPOmYlJ2itILQ==
releaseDate: '2026-10-03T21:49:07.572Z'
`;

const updaterRequire = createRequire(require.resolve("electron-updater"));
const electronUpdaterYaml = updaterRequire("js-yaml") as {
	load: (text: string) => unknown;
};
const electronMacUpdater = updaterRequire("./MacUpdater.js") as {
	MacUpdater: {
		filterFilesForArch(
			files: Array<{ url: URL; info: { url: string } }>,
			isArm64Mac: boolean,
		): Array<{ url: URL; info: { url: string } }>;
	};
};

function zipFor(
	files: readonly { url: string; sha512: string; size: number }[],
	arm64Mac: boolean,
): string | undefined {
	const resolved = files.map((file) => ({
		url: new URL(file.url, "https://updates.example.invalid"),
		info: { url: file.url },
	}));
	return electronMacUpdater.MacUpdater.filterFilesForArch(resolved, arm64Mac).find((file) =>
		file.url.pathname.endsWith(".zip"),
	)?.info.url;
}

describe("macOS update manifest merge", () => {
	test("publishes both architectures so Apple Silicon updates to the arm64 build", () => {
		const published = parseUpdateManifest(x64Manifest, "published");
		expect(zipFor(published.files, true)).toBe("Signet-0.230.6-mac-x64.zip");

		const merged = renderUpdateManifest(
			mergeMacUpdateManifests(parseUpdateManifest(x64Manifest, "x64"), parseUpdateManifest(arm64Manifest, "arm64")),
		);
		const loaded = electronUpdaterYaml.load(merged) as {
			version: string;
			files: { url: string; sha512: string; size: number }[];
			path: string;
			releaseDate: unknown;
		};
		expect(loaded.version).toBe("0.230.6");
		expect(loaded.files.map((file) => file.url)).toEqual([
			"Signet-0.230.6-mac-x64.zip",
			"Signet-0.230.6-mac-x64.dmg",
			"Signet-0.230.6-mac-arm64.zip",
			"Signet-0.230.6-mac-arm64.dmg",
		]);
		expect(loaded.files[2]?.sha512).toBe(
			"LOdKHF73q34IbYIXaLwCN1cqxd9ruErOTMqYbpPMRnllqFveCSqzPKSXklOriXZsHvg9jnADdbPOmYlJ2itILQ==",
		);
		expect(loaded.files[2]?.size).toBe(186557278);
		expect(loaded.path).toBe("Signet-0.230.6-mac-x64.zip");
		expect(loaded.releaseDate).toBe("2026-10-03T21:49:07.572Z");
		expect(zipFor(loaded.files, true)).toBe("Signet-0.230.6-mac-arm64.zip");
		expect(zipFor(loaded.files, false)).toBe("Signet-0.230.6-mac-x64.zip");
	});

	test("refuses mismatched or mislabeled manifests", () => {
		const x64 = parseUpdateManifest(x64Manifest, "x64");
		const arm64 = parseUpdateManifest(arm64Manifest, "arm64");
		expect(() => mergeMacUpdateManifests(arm64, x64)).toThrow("x64 manifest lists Signet-0.230.6-mac-arm64.zip");
		expect(() =>
			mergeMacUpdateManifests(x64, parseUpdateManifest(arm64Manifest.replaceAll("0.230.6", "0.230.7"), "arm64")),
		).toThrow("version mismatch");
		expect(() =>
			mergeMacUpdateManifests(x64, { ...arm64, files: arm64.files.filter((file) => !file.url.endsWith(".zip")) }),
		).toThrow("arm64 manifest lists no zip");
		expect(() => parseUpdateManifest("version: 0.230.6\nfiles: []\n", "empty")).toThrow("empty lists no files");
	});

	test("rejects a stale or single-architecture published manifest", () => {
		const merged = parseUpdateManifest(
			renderUpdateManifest(
				mergeMacUpdateManifests(parseUpdateManifest(x64Manifest, "x64"), parseUpdateManifest(arm64Manifest, "arm64")),
			),
			"published",
		);
		expect(() => validateMergedMacUpdateManifest(merged, "0.230.7")).toThrow("published manifest version mismatch");
		validateMergedMacUpdateManifest(merged, "0.230.6");
		expect(() =>
			validateMergedMacUpdateManifest(
				{ ...merged, files: merged.files.filter((file) => !file.url.includes("arm64")) },
				"0.230.6",
			),
		).toThrow("published manifest lists no arm64 zip");
	});

	test("the command writes and verifies the merged manifest", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-mac-manifest-"));
		try {
			writeFileSync(join(directory, "x64.yml"), x64Manifest);
			writeFileSync(join(directory, "arm64.yml"), arm64Manifest);
			const result = spawnSync(
				process.execPath,
				[
					join(import.meta.dir, "merge-mac-update-manifest.ts"),
					"--x64",
					join(directory, "x64.yml"),
					"--arm64",
					join(directory, "arm64.yml"),
					"--out",
					join(directory, "latest-mac.yml"),
				],
				{ encoding: "utf8" },
			);
			expect(result.status).toBe(0);
			const written = parseUpdateManifest(readFileSync(join(directory, "latest-mac.yml"), "utf8"), "written");
			expect(written.files).toHaveLength(4);
			const verification = spawnSync(
				process.execPath,
				[
					join(import.meta.dir, "merge-mac-update-manifest.ts"),
					"--verify",
					join(directory, "latest-mac.yml"),
					"--version",
					"0.230.6",
				],
				{ encoding: "utf8" },
			);
			expect(verification.status).toBe(0);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});

	test("release finalization verifies the published macOS manifest contents", () => {
		const workflow = readFileSync(
			join(import.meta.dir, "..", "..", "..", ".github", "workflows", "release.yml"),
			"utf8",
		);
		expect(workflow).toContain(`gh release download "v\${NEW_VERSION}" --pattern "latest-mac.yml"`);
		expect(workflow).toContain(`--verify "\${manifest_dir}/latest-mac.yml"`);
		expect(workflow).toContain(`--version "\${NEW_VERSION}"`);
	});

	test("macOS build jobs leave latest-mac.yml to the merge job", () => {
		const workflow = readFileSync(
			join(import.meta.dir, "..", "..", "..", ".github", "workflows", "desktop-build.yml"),
			"utf8",
		);
		const build = workflow.slice(workflow.indexOf("  build:"), workflow.indexOf("  publish-mac-update-manifest:"));
		const merge = workflow.slice(
			workflow.indexOf("  publish-mac-update-manifest:"),
			workflow.indexOf("  validate-aur:"),
		);
		expect(build).toContain('= "latest-mac.yml" ]; then');
		expect(build).toContain('publish_files[@]}" --clobber');
		expect(merge).toContain("needs: build");
		expect(merge).toContain("name: desktop-macos-x64");
		expect(merge).toContain("name: desktop-macos-arm64");
		expect(merge).toContain("bun surfaces/desktop/scripts/merge-mac-update-manifest.ts");
		expect(merge).toContain("mac-update/latest-mac.yml --clobber");
	});
});
