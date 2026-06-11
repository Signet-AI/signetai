#!/usr/bin/env bun

import { cpSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const NPM_PACKAGE_RENAMES: ReadonlyMap<string, string> = new Map([
	["@signet/core", "@signetai/core"],
	["@signet/connector-base", "@signetai/connector-base"],
	["@signet/connector-claude-code", "@signetai/connector-claude-code"],
	["@signet/connector-codex", "@signetai/connector-codex"],
	["@signet/connector-gemini", "@signetai/connector-gemini"],
	["@signet/connector-hermes-agent", "@signetai/connector-hermes-agent"],
	["@signet/connector-oh-my-pi", "@signetai/connector-oh-my-pi"],
	["@signet/connector-openclaw", "@signetai/connector-openclaw"],
	["@signet/connector-opencode", "@signetai/connector-opencode"],
	["@signet/connector-pi", "@signetai/connector-pi"],
	["@signet/codex-plugin", "@signetai/codex-plugin"],
]);

const PUBLISH_TARGETS = [
	["platform/core", "core"],
	["libs/connector-base", "connector-base"],
	["integrations/claude-code/connector", "connector-claude-code"],
	["integrations/codex/connector", "connector-codex"],
	["integrations/gemini/connector", "connector-gemini"],
	["integrations/hermes-agent/connector", "connector-hermes-agent"],
	["integrations/oh-my-pi/connector", "connector-oh-my-pi"],
	["integrations/openclaw/connector", "connector-openclaw"],
	["integrations/opencode/connector", "connector-opencode"],
	["integrations/pi/connector", "connector-pi"],
	["integrations/codex/plugin", "codex-plugin"],
] as const;

const TEXT_EXTENSIONS = new Set([".js", ".mjs", ".cjs", ".ts", ".d.ts", ".json", ".md", ".map"]);

function looksTextFile(file: string): boolean {
	if (file.endsWith(".d.ts.map")) return true;
	const dot = file.lastIndexOf(".");
	return dot !== -1 && TEXT_EXTENSIONS.has(file.slice(dot));
}

export function rewritePackageSpecifiers(text: string): string {
	let next = text;
	for (const [from, to] of NPM_PACKAGE_RENAMES) {
		next = next.split(from).join(to);
	}
	return next.split("@signet/connector-${harness}").join("@signetai/connector-${harness}");
}

export function rewritePackageManifest(raw: string): string {
	const pkg = JSON.parse(raw) as Record<string, unknown>;
	if (typeof pkg.name === "string") {
		pkg.name = NPM_PACKAGE_RENAMES.get(pkg.name) ?? pkg.name;
	}

	for (const field of ["dependencies", "optionalDependencies", "peerDependencies", "devDependencies"] as const) {
		const deps = pkg[field];
		if (!deps || typeof deps !== "object" || Array.isArray(deps)) continue;
		const rewritten: Record<string, unknown> = {};
		for (const [name, spec] of Object.entries(deps as Record<string, unknown>)) {
			rewritten[NPM_PACKAGE_RENAMES.get(name) ?? name] = spec;
		}
		pkg[field] = rewritten;
	}

	return `${JSON.stringify(pkg, null, 2)}\n`;
}

function rewriteTextFiles(dir: string): void {
	for (const entry of readdirSync(dir)) {
		const path = join(dir, entry);
		const stat = statSync(path);
		if (stat.isDirectory()) {
			rewriteTextFiles(path);
			continue;
		}
		if (!stat.isFile() || !looksTextFile(path) || stat.size > 5_000_000) continue;

		const raw = readFileSync(path, "utf8");
		if (raw.includes("\0")) continue;
		const next = entry === "package.json" ? rewritePackageManifest(raw) : rewritePackageSpecifiers(raw);
		if (next !== raw) writeFileSync(path, next);
	}
}

export function stageNpmPublishPackages(outputDir: string): string[] {
	rmSync(outputDir, { force: true, recursive: true });
	mkdirSync(outputDir, { recursive: true });

	const staged: string[] = [];
	for (const [sourceDir, stageName] of PUBLISH_TARGETS) {
		const targetDir = join(outputDir, stageName);
		cpSync(sourceDir, targetDir, {
			filter: (source) => !source.split(/[\\/]/).includes("node_modules"),
			recursive: true,
		});
		rewriteTextFiles(targetDir);
		staged.push(targetDir);
	}
	return staged;
}

if (import.meta.main) {
	const outputDir = process.argv[2];
	if (!outputDir) {
		throw new Error("Usage: bun scripts/stage-npm-publish.ts <output-dir>");
	}
	for (const dir of stageNpmPublishPackages(outputDir)) {
		console.log(dir);
	}
}
