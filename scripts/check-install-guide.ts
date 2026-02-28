#!/usr/bin/env bun

import { readFileSync } from "node:fs";

interface Rule {
	kind: "require" | "forbid";
	pattern: RegExp;
	description: string;
}

function load(path: string): string {
	return readFileSync(path, "utf8");
}

function runRules(path: string, content: string, rules: Rule[]): string[] {
	const failures: string[] = [];

	for (const rule of rules) {
		const matched = rule.pattern.test(content);
		if (rule.kind === "require" && !matched) {
			failures.push(`[${path}] Missing: ${rule.description}`);
		}
		if (rule.kind === "forbid" && matched) {
			failures.push(`[${path}] Forbidden content found: ${rule.description}`);
		}
	}

	return failures;
}

function main(): void {
	const skillPath = "web/public/skill.md";
	const readmePath = "README.md";
	const heroPath = "web/src/components/landing/Hero.astro";
	const ctaPath = "web/src/components/landing/Cta.astro";

	const expectedPrompt =
		"Install and fully configure Signet AI by following this guide exactly: https://signetai.sh/skill.md";

	const skill = load(skillPath);
	const readme = load(readmePath);
	const hero = load(heroPath);
	const cta = load(ctaPath);

	const failures: string[] = [];

	failures.push(
		...runRules(skillPath, skill, [
			{
				kind: "require",
				pattern: /## Install Objective \(Must Complete\)/,
				description: "Install objective section",
			},
			{
				kind: "require",
				pattern: /`signet --version` succeeds/,
				description: "Completion check for signet --version",
			},
			{
				kind: "require",
				pattern: /`signet status` shows the daemon is running/,
				description: "Completion check for daemon running",
			},
			{
				kind: "require",
				pattern: /"status":"healthy"/,
				description: "Health response requirement (status healthy)",
			},
			{
				kind: "require",
				pattern: /There is intentionally no `signet secret get` command/,
				description: "Explicit secret-get deprecation note",
			},
			{
				kind: "forbid",
				pattern: /^\s*signet secret get\b/m,
				description: "Deprecated command: signet secret get",
			},
			{
				kind: "forbid",
				pattern: /# Should return OK/,
				description: "Outdated health expectation comment",
			},
		]),
	);

	const promptRule: Rule = {
		kind: "require",
		pattern: new RegExp(expectedPrompt.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")),
		description: `Expected install prompt: ${expectedPrompt}`,
	};

	failures.push(...runRules(readmePath, readme, [promptRule]));
	failures.push(...runRules(heroPath, hero, [promptRule]));
	failures.push(...runRules(ctaPath, cta, [promptRule]));

	if (failures.length > 0) {
		console.error("Install guide guard failed:\n");
		for (const failure of failures) {
			console.error(`- ${failure}`);
		}
		process.exit(1);
	}

	console.log("Install guide guard passed.");
}

main();
