#!/usr/bin/env bun

import { resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "..");
const BIOME_EXTENSIONS = [
	".astro",
	".cjs",
	".cts",
	".js",
	".json",
	".jsonc",
	".mjs",
	".mts",
	".jsx",
	".ts",
	".tsx",
] as const;
const BIOME_EXCLUDED_PARTS = new Set([
	".astro",
	".bench",
	".svelte-kit",
	".wrangler",
	"build",
	"built",
	"coverage",
	"dist",
	"fixtures",
	"generated",
	"node_modules",
	"references",
	"target",
]);

function stagedFiles(): readonly string[] {
	const result = Bun.spawnSync({
		cmd: ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"],
		cwd: ROOT,
		stderr: "pipe",
		stdout: "pipe",
	});
	if (result.exitCode !== 0) throw new Error("Could not inspect staged files");
	return new TextDecoder().decode(result.stdout).split("\n").filter(Boolean);
}

function hasBiomeFiles(): boolean {
	return stagedFiles().some((file) => {
		const normalized = file.replaceAll("\\", "/");
		const extension = BIOME_EXTENSIONS.find((candidate) => normalized.endsWith(candidate));
		if (extension === undefined) return false;
		return !normalized.split("/").some((part) => BIOME_EXCLUDED_PARTS.has(part));
	});
}

async function run(label: string, command: readonly string[]): Promise<number> {
	console.log(`\n${label}`);
	const child = Bun.spawn([...command], {
		cwd: ROOT,
		stderr: "inherit",
		stdout: "inherit",
	});
	return child.exited;
}

async function main(): Promise<void> {
	console.log(
		"Documentation reminder: if this commit changes user-visible behavior, APIs, schemas, configuration, or lifecycle, update the owning documentation as necessary.",
	);

	if (hasBiomeFiles()) {
		const biome = await run("Running staged Biome validation", ["bun", "run", "biome", "check", "--staged"]);
		if (biome !== 0) {
			process.exitCode = biome;
			return;
		}
	} else {
		console.log("No Biome-supported staged files; skipping staged Biome validation");
	}

	process.exitCode = await run("Running workspace typecheck", ["bun", "run", "typecheck"]);
}

if (import.meta.main) await main();
