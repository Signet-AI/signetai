/** Regression guard for local CommonJS imports left in native worker bundles. */
import { spawnSync } from "node:child_process";
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const tempDirs: string[] = [];

function unbundledRelativeRequires(source: string): readonly string[] {
	const specifiers = new Set<string>();
	const pattern = /(?:__)?require[A-Za-z0-9_$]*(?:\.resolve)?\(\s*["'](\.{1,2}[/\\][^"']+)["']\s*\)/g;
	for (const match of source.matchAll(pattern)) {
		const specifier = match[1];
		const normalized = specifier?.replaceAll("\\", "/");
		// Bun keeps bundled CommonJS modules in an internal registry keyed by
		// their node_modules path; those calls are not filesystem lookups.
		if (
			specifier !== undefined &&
			normalized !== undefined &&
			!normalized.endsWith(".node") &&
			!normalized.includes("/node_modules/")
		)
			specifiers.add(specifier);
	}
	return [...specifiers].sort();
}

afterEach(() => {
	for (const directory of tempDirs.splice(0)) rmSync(directory, { recursive: true, force: true });
});

describe("native worker bundle contract", () => {
	test("bundles DB-owner Dreaming finalization without a local CommonJS require", () => {
		const directory = mkdtempSync(join(tmpdir(), "signet-native-worker-contract-"));
		tempDirs.push(directory);
		const output = join(directory, "db-owner-worker.mjs");
		const entrypoint = join(root, "platform", "daemon", "src", "db-owner-worker.ts");
		const result = spawnSync(
			"bun",
			["build", "--target=bun", "--format=esm", "--outfile", output, "--external", "better-sqlite3", entrypoint],
			{ cwd: root, encoding: "utf8", windowsHide: true },
		);
		if (result.status !== 0) {
			console.error(result.stdout);
			console.error(result.stderr);
			throw new Error(`DB-owner worker bundle failed: ${result.error?.message ?? result.status ?? "unknown"}`);
		}
		if (!existsSync(output)) throw new Error(`DB-owner worker bundle was not written to ${output}`);

		expect(unbundledRelativeRequires(readFileSync(output, "utf8"))).toEqual([]);
	}, 120_000);
});
