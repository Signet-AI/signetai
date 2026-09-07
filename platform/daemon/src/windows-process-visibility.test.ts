import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = fileURLToPath(new URL("../../../", import.meta.url));
const runtimeRoots = [
	join(repoRoot, "platform", "core", "src"),
	join(repoRoot, "platform", "daemon", "src"),
	join(repoRoot, "surfaces", "cli", "src"),
	join(repoRoot, "surfaces", "desktop", "src"),
	join(repoRoot, "integrations"),
] as const;
const sharedLauncherPath = join(repoRoot, "platform", "core", "src", "child-process.ts");

function productionSourceFiles(root: string): readonly string[] {
	const files: string[] = [];
	for (const entry of readdirSync(root, { withFileTypes: true })) {
		const path = join(root, entry.name);
		if (entry.isDirectory()) {
			if (entry.name === "node_modules" || entry.name === "dist" || entry.name === "scripts") continue;
			files.push(...productionSourceFiles(path));
			continue;
		}
		if (!/\.(?:cjs|js|mjs|ts|tsx)$/.test(entry.name)) continue;
		if (/(?:\.bench|\.spec|\.test)\.[^.]+$/.test(entry.name)) continue;
		if (path === sharedLauncherPath) continue;
		files.push(path);
	}
	return files;
}

function relativeSourcePath(path: string): string {
	return relative(repoRoot, path).replaceAll("\\", "/");
}

describe("shared child-process launcher", () => {
	test("keeps production launchers behind the shared adapter", () => {
		const violations: string[] = [];
		for (const root of runtimeRoots) {
			for (const path of productionSourceFiles(root)) {
				const source = readFileSync(path, "utf8");
				if (
					/(?:from\s+["'](?:node:)?child_process["']|(?:import|require)\(\s*["'](?:node:)?child_process["']\s*\))/.test(
						source,
					)
				) {
					violations.push(`${relativeSourcePath(path)} imports child_process directly`);
				}
				if (/\bBun\.spawn(?:Sync)?\s*\(/.test(source)) {
					violations.push(`${relativeSourcePath(path)} calls Bun.spawn directly`);
				}
			}
		}
		expect(violations).toEqual([]);
	});
});
