#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const REFERENCE_FILE = "packages/signetai/package.json";
const EXCLUDED_FILES = new Set(["packages/cli/dashboard/package.json"]);

function parseSemver(version: string): [number, number, number] {
	const match = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
	if (!match) {
		throw new Error(`Expected x.y.z version, got '${version}'`);
	}

	return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function compareSemver(a: string, b: string): number {
	const [aMajor, aMinor, aPatch] = parseSemver(a);
	const [bMajor, bMinor, bPatch] = parseSemver(b);

	if (aMajor !== bMajor) return aMajor - bMajor;
	if (aMinor !== bMinor) return aMinor - bMinor;
	return aPatch - bPatch;
}

function readPackageVersion(filePath: string): string {
	const raw = readFileSync(filePath, "utf8");
	const parsed = JSON.parse(raw) as { version?: unknown };
	if (typeof parsed.version !== "string") {
		throw new Error(`Missing version in ${filePath}`);
	}

	return parsed.version;
}

function getRemoteVersion(filePath: string): string | null {
	try {
		const raw = execSync(`git show origin/main:${filePath}`, {
			encoding: "utf8",
			stdio: ["ignore", "pipe", "ignore"],
		});
		const parsed = JSON.parse(raw) as { version?: unknown };
		return typeof parsed.version === "string" ? parsed.version : null;
	} catch {
		return null;
	}
}

function listTargetPackageFiles(): string[] {
	const output = execSync(
		"git ls-files package.json 'packages/**/package.json'",
		{
			encoding: "utf8",
		},
	);

	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((file) => !EXCLUDED_FILES.has(file));
}

function updateFileVersion(filePath: string, targetVersion: string): boolean {
	const raw = readFileSync(filePath, "utf8");
	const versionPattern = /("version"\s*:\s*")([^"]+)(")/;
	if (!versionPattern.test(raw)) {
		throw new Error(`Could not find version field in ${filePath}`);
	}

	const next = raw.replace(versionPattern, `$1${targetVersion}$3`);
	if (next === raw) {
		return false;
	}

	writeFileSync(filePath, next);
	return true;
}

function listCargoFiles(): string[] {
	const output = execSync("git ls-files 'packages/**/Cargo.toml'", {
		encoding: "utf8",
	});

	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function readCargoVersion(filePath: string): string | null {
	const raw = readFileSync(filePath, "utf8");
	const match = raw.match(/\[package\][^\[]*version\s*=\s*"([^"]+)"/s);
	return match ? match[1] : null;
}

function updateCargoVersion(filePath: string, targetVersion: string): boolean {
	const raw = readFileSync(filePath, "utf8");
	// Anchor to [package] section to avoid matching dependency version strings
	const versionPattern = /(\[package\][^\[]*version\s*=\s*")([^"]+)(")/s;
	if (!versionPattern.test(raw)) {
		throw new Error(`Could not find [package] version in ${filePath}`);
	}

	const next = raw.replace(versionPattern, `$1${targetVersion}$3`);
	if (next === raw) {
		return false;
	}

	writeFileSync(filePath, next);
	return true;
}

function regenerateCargoLock(cargoFile: string): void {
	const dir = cargoFile.replace(/\/Cargo\.toml$/, "");
	try {
		// --workspace avoids bumping transitive deps (unlike generate-lockfile)
		execSync("cargo update --workspace", { cwd: dir, stdio: "ignore" });
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		if (msg.includes("not found") || msg.includes("ENOENT")) {
			// cargo not installed — non-fatal
		} else {
			console.warn(`Warning: cargo update failed in ${dir}: ${msg}`);
		}
	}
}

function getArg(name: string): string | null {
	const index = process.argv.indexOf(name);
	if (index === -1) {
		return null;
	}

	return process.argv[index + 1] ?? null;
}

function main() {
	const explicitVersion = getArg("--to");
	if (explicitVersion) {
		parseSemver(explicitVersion);
	}

	const localReferenceVersion = readPackageVersion(REFERENCE_FILE);
	const remoteReferenceVersion = getRemoteVersion(REFERENCE_FILE);

	const targetVersion = explicitVersion
		? explicitVersion
		: remoteReferenceVersion &&
				compareSemver(remoteReferenceVersion, localReferenceVersion) > 0
			? remoteReferenceVersion
			: localReferenceVersion;

	const packageFiles = listTargetPackageFiles();
	if (packageFiles.length === 0) {
		throw new Error("No package.json files found under packages/");
	}

	const updated: string[] = [];
	for (const file of packageFiles) {
		if (updateFileVersion(file, targetVersion)) {
			updated.push(file);
		}
	}

	const mismatches: string[] = [];
	for (const file of packageFiles) {
		const version = readPackageVersion(file);
		if (version !== targetVersion) {
			mismatches.push(`${file} (${version})`);
		}
	}

	if (mismatches.length > 0) {
		throw new Error(
			`Version sync failed. Mismatches:\n- ${mismatches.join("\n- ")}`,
		);
	}

	if (
		!explicitVersion &&
		remoteReferenceVersion &&
		compareSemver(remoteReferenceVersion, localReferenceVersion) > 0
	) {
		console.log(
			`Local reference (${localReferenceVersion}) was behind origin/main (${remoteReferenceVersion}).`,
		);
	}

	// Sync Cargo.toml files under packages/
	const cargoUpdated: string[] = [];
	const cargoFiles = listCargoFiles();
	for (const file of cargoFiles) {
		if (updateCargoVersion(file, targetVersion)) {
			cargoUpdated.push(file);
			regenerateCargoLock(file);
		}
	}

	const cargoMismatches: string[] = [];
	for (const file of cargoFiles) {
		const version = readCargoVersion(file);
		if (version !== targetVersion) {
			cargoMismatches.push(`${file} (${version ?? "missing"})`);
		}
	}

	if (cargoMismatches.length > 0) {
		throw new Error(
			`Cargo version sync failed. Mismatches:\n- ${cargoMismatches.join("\n- ")}`,
		);
	}

	if (updated.length === 0 && cargoUpdated.length === 0) {
		console.log(`All versions already aligned at ${targetVersion}.`);
		return;
	}

	if (updated.length > 0) {
		console.log(
			`Aligned ${updated.length} package.json files to ${targetVersion}:`,
		);
		for (const file of updated) {
			console.log(`- ${file}`);
		}
	}

	if (cargoUpdated.length > 0) {
		console.log(
			`Aligned ${cargoUpdated.length} Cargo.toml files to ${targetVersion}:`,
		);
		for (const file of cargoUpdated) {
			console.log(`- ${file}`);
		}
	}
}

main();
