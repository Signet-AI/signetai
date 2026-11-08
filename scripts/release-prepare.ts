#!/usr/bin/env bun

import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { computeBumpLevel } from "./bump-level";
import { getCommitLog, getPreviousTag, readVersion } from "./changelog";

export function computeReleaseVersion(current: string, subjects: readonly string[], explicit?: string): string {
	const plain = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
	if (!plain.test(current)) throw new Error(`Expected plain x.y.z version: ${current}`);
	if (explicit !== undefined) {
		if (!plain.test(explicit)) throw new Error(`Expected plain x.y.z version: ${explicit}`);
		if (Bun.semver.order(explicit, current) <= 0) throw new Error(`Version must be greater than ${current}`);
		return explicit;
	}
	const parts = current.split(".");
	const major = Number(parts[0]);
	const minor = Number(parts[1]);
	const patch = Number(parts[2]);
	switch (computeBumpLevel(subjects)) {
		case "major":
			return `${major + 1}.0.0`;
		case "minor":
			return `${major}.${minor + 1}.0`;
		case "patch":
			return `${major}.${minor}.${patch + 1}`;
	}
}

if (import.meta.main) {
	if (process.argv.length > 3) throw new Error("Usage: bun run release:prepare [version]");
	const previous = getPreviousTag();
	const version = computeReleaseVersion(
		readVersion(),
		getCommitLog(previous ? `${previous}..HEAD` : "HEAD"),
		process.argv[2],
	);
	execFileSync(process.execPath, ["scripts/version-sync.ts", "--to", version], { stdio: "inherit" });
	execFileSync(process.execPath, ["scripts/changelog.ts", "--version", version], { stdio: "inherit" });
	rmSync(".bump-level", { force: true });
	execFileSync(process.execPath, ["install"], { stdio: "inherit" });
	console.log(`Review the CHANGELOG.md section for ${version} and the version/lockfile diff.
Open a PR titled: chore: release ${version}
After merging, dispatch Release on main with channel=check, then channel=stable.`);
}
