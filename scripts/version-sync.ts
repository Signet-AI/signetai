#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const REFERENCE_FILE = "dist/signetai/package.json";
const EXCLUDED_FILES = new Set(["surfaces/dashboard/package.json"]);
const EXCLUDED_CARGO_FILES = new Set(["runtimes/forge/Cargo.toml"]);
const FORGE_VERSION_FILE = "runtimes/forge/forge-version.json";
export const VERSION_SYNC_PACKAGE_GLOBS = [
	"package.json",
	"platform/**/package.json",
	"surfaces/**/package.json",
	"integrations/**/package.json",
	"libs/**/package.json",
	"dist/**/package.json",
] as const;
const FORGE_MANIFEST_FILES = [
	"surfaces/cli/templates/forge/manifest.json",
	"dist/signetai/templates/forge/manifest.json",
];

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
	const output = execSync(`git ls-files ${VERSION_SYNC_PACKAGE_GLOBS.map((glob) => `'${glob}'`).join(" ")}`, {
		encoding: "utf8",
	});

	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((file) => !EXCLUDED_FILES.has(file));
}

function updateFileVersion(filePath: string, targetVersion: string, checkOnly: boolean): boolean {
	const raw = readFileSync(filePath, "utf8");
	const versionPattern = /("version"\s*:\s*")([^"]+)(")/;
	if (!versionPattern.test(raw)) {
		throw new Error(`Could not find version field in ${filePath}`);
	}

	const next = raw.replace(versionPattern, `$1${targetVersion}$3`);
	if (next === raw) {
		return false;
	}

	if (!checkOnly) {
		writeFileSync(filePath, next);
	}
	return true;
}

function listCargoFiles(): string[] {
	const output = execSync("git ls-files 'platform/**/Cargo.toml' 'runtimes/**/Cargo.toml'", {
		encoding: "utf8",
	});

	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.filter((file) => !EXCLUDED_CARGO_FILES.has(file));
}

function readCargoVersion(filePath: string): string | null {
	const raw = readFileSync(filePath, "utf8");
	// Match [package] or [workspace.package] section
	const match = raw.match(/\[(?:workspace\.)?package\][^\[]*version\s*=\s*"([^"]+)"/s);
	return match ? match[1] : null;
}

function readCargoPackageName(filePath: string): string | null {
	const raw = readFileSync(filePath, "utf8");
	const match = raw.match(/\[package\][^\[]*name\s*=\s*"([^"]+)"/s);
	return match ? match[1] : null;
}

function findNearestCargoLock(filePath: string): string | null {
	let dir = dirname(filePath);
	while (dir !== "." && dir !== "/") {
		const lockFile = join(dir, "Cargo.lock");
		if (existsSync(lockFile)) return lockFile;
		dir = dirname(dir);
	}
	return null;
}

function findNearestWorkspaceVersion(filePath: string): string | null {
	let dir = dirname(filePath);
	while (dir !== "." && dir !== "/") {
		const cargoFile = join(dir, "Cargo.toml");
		if (existsSync(cargoFile)) {
			const raw = readFileSync(cargoFile, "utf8");
			const match = raw.match(/\[workspace\.package\][^\[]*version\s*=\s*"([^"]+)"/s);
			if (match) return match[1];
		}
		dir = dirname(dir);
	}
	return null;
}

export function findCargoLockPackageVersion(raw: string, packageName: string): string | null {
	const packages = raw.split(/\n\[\[package\]\]\n/);
	for (const block of packages) {
		const name = block.match(/(?:^|\n)name\s*=\s*"([^"]+)"/);
		if (name?.[1] !== packageName) continue;
		const version = block.match(/(?:^|\n)version\s*=\s*"([^"]+)"/);
		return version?.[1] ?? null;
	}
	return null;
}

export function collectCargoLockMismatches(cargoFiles: readonly string[], targetVersion: string): string[] {
	const mismatches: string[] = [];
	for (const file of cargoFiles) {
		const raw = readFileSync(file, "utf8");
		const name = readCargoPackageName(file);
		if (!name) continue;

		const expected = usesWorkspaceVersion(raw) ? findNearestWorkspaceVersion(file) : readCargoVersion(file);
		if (expected !== targetVersion) continue;

		const lockFile = findNearestCargoLock(file);
		if (!lockFile) {
			mismatches.push(`${file} (${name}) has no Cargo.lock`);
			continue;
		}

		const lockVersion = findCargoLockPackageVersion(readFileSync(lockFile, "utf8"), name);
		if (lockVersion !== targetVersion) {
			mismatches.push(`${lockFile} package ${name} (${lockVersion ?? "missing"})`);
		}
	}
	return mismatches;
}

function usesWorkspaceVersion(raw: string): boolean {
	// Only match version.workspace inside [package], not in dependency tables
	return /\[package\][^\[]*version\.workspace\s*=\s*true/s.test(raw);
}

function updateCargoVersion(filePath: string, targetVersion: string, checkOnly: boolean): boolean {
	const raw = readFileSync(filePath, "utf8");
	// Crates that inherit version from workspace root — nothing to update
	if (usesWorkspaceVersion(raw)) return false;
	// Match [package] or [workspace.package] section
	const versionPattern = /(\[(?:workspace\.)?package\][^\[]*version\s*=\s*")([^"]+)(")/s;
	if (!versionPattern.test(raw)) {
		throw new Error(`Could not find [package] version in ${filePath}`);
	}

	const next = raw.replace(versionPattern, `$1${targetVersion}$3`);
	if (next === raw) {
		return false;
	}

	if (!checkOnly) {
		writeFileSync(filePath, next);
	}
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

function resolveWorkspaceProtocols(files: readonly string[], version: string, checkOnly: boolean): string[] {
	const patched: string[] = [];
	for (const file of files) {
		const raw = readFileSync(file, "utf8");
		const pkg = JSON.parse(raw) as Record<string, unknown>;
		// Only resolve for packages that will be published
		if (!pkg.publishConfig || pkg.private) continue;

		let changed = raw;
		// Replace workspace: protocols with resolved versions
		changed = changed.replace(/"workspace:\*"/g, `"${version}"`);
		changed = changed.replace(/"workspace:\^"/g, `"^${version}"`);
		changed = changed.replace(/"workspace:~"/g, `"~${version}"`);
		if (changed !== raw) {
			if (!checkOnly) {
				writeFileSync(file, changed);
			}
			patched.push(file);
		}
	}
	return patched;
}

function getArg(name: string): string | null {
	const index = process.argv.indexOf(name);
	if (index === -1) {
		return null;
	}

	return process.argv[index + 1] ?? null;
}

function hasFlag(name: string): boolean {
	return process.argv.includes(name);
}

function syncForgeManifestCopies(checkOnly: boolean): string[] {
	const source = readFileSync(FORGE_VERSION_FILE, "utf8");
	const updated: string[] = [];
	for (const file of FORGE_MANIFEST_FILES) {
		const raw = readFileSync(file, "utf8");
		if (raw === source) continue;
		if (!checkOnly) {
			writeFileSync(file, source);
		}
		updated.push(file);
	}
	return updated;
}

function main() {
	const explicitVersion = getArg("--to");
	const checkOnly = hasFlag("--check");
	if (explicitVersion && checkOnly) {
		throw new Error("Use either --to or --check, not both");
	}
	if (explicitVersion) {
		parseSemver(explicitVersion);
	}

	const localReferenceVersion = readPackageVersion(REFERENCE_FILE);
	const remoteReferenceVersion = getRemoteVersion(REFERENCE_FILE);

	const targetVersion = explicitVersion
		? explicitVersion
		: remoteReferenceVersion && compareSemver(remoteReferenceVersion, localReferenceVersion) > 0
			? remoteReferenceVersion
			: localReferenceVersion;

	const packageFiles = listTargetPackageFiles();
	if (packageFiles.length === 0) {
		throw new Error("No workspace package.json files found");
	}

	const updated: string[] = [];
	for (const file of packageFiles) {
		if (updateFileVersion(file, targetVersion, checkOnly)) {
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
		throw new Error(`Version sync failed. Mismatches:\n- ${mismatches.join("\n- ")}`);
	}

	if (!explicitVersion && remoteReferenceVersion && compareSemver(remoteReferenceVersion, localReferenceVersion) > 0) {
		console.log(`Local reference (${localReferenceVersion}) was behind origin/main (${remoteReferenceVersion}).`);
	}

	// Resolve workspace: protocols in publishable packages so npm publish
	// ships real version strings instead of "workspace:*".
	const resolved = resolveWorkspaceProtocols(packageFiles, targetVersion, checkOnly);

	// Sync Cargo.toml files under platform/ and runtimes/
	const cargoUpdated: string[] = [];
	const cargoFiles = listCargoFiles();
	for (const file of cargoFiles) {
		if (updateCargoVersion(file, targetVersion, checkOnly)) {
			cargoUpdated.push(file);
			if (!checkOnly) {
				regenerateCargoLock(file);
			}
		}
	}

	const cargoMismatches: string[] = [];
	for (const file of cargoFiles) {
		const raw = readFileSync(file, "utf8");
		if (usesWorkspaceVersion(raw)) continue;
		const version = readCargoVersion(file);
		if (version !== targetVersion) {
			cargoMismatches.push(`${file} (${version ?? "missing"})`);
		}
	}

	if (cargoMismatches.length > 0) {
		throw new Error(`Cargo version sync failed. Mismatches:\n- ${cargoMismatches.join("\n- ")}`);
	}

	let cargoLockMismatches = collectCargoLockMismatches(cargoFiles, targetVersion);
	if (!checkOnly && cargoLockMismatches.length > 0) {
		for (const file of cargoFiles) {
			regenerateCargoLock(file);
		}
		cargoLockMismatches = collectCargoLockMismatches(cargoFiles, targetVersion);
	}
	if (!checkOnly && cargoLockMismatches.length > 0) {
		throw new Error(`Cargo.lock version sync failed. Mismatches:\n- ${cargoLockMismatches.join("\n- ")}`);
	}

	const forgeManifestUpdated = syncForgeManifestCopies(checkOnly);

	if (
		checkOnly &&
		(updated.length > 0 ||
			cargoUpdated.length > 0 ||
			cargoLockMismatches.length > 0 ||
			resolved.length > 0 ||
			forgeManifestUpdated.length > 0)
	) {
		const drift = [
			...updated.map((file) => `package version: ${file}`),
			...cargoUpdated.map((file) => `Cargo version: ${file}`),
			...cargoLockMismatches.map((file) => `Cargo.lock version: ${file}`),
			...resolved.map((file) => `workspace protocol: ${file}`),
			...forgeManifestUpdated.map((file) => `Forge manifest copy: ${file}`),
		];
		throw new Error(
			`Version sync drift detected at ${targetVersion}:\n- ${drift.join("\n- ")}\n\nRun bun scripts/version-sync.ts before merging.`,
		);
	}

	if (
		updated.length === 0 &&
		cargoUpdated.length === 0 &&
		cargoLockMismatches.length === 0 &&
		resolved.length === 0 &&
		forgeManifestUpdated.length === 0
	) {
		console.log(`All versions already aligned at ${targetVersion}.`);
		return;
	}

	if (updated.length > 0) {
		console.log(`Aligned ${updated.length} package.json files to ${targetVersion}:`);
		for (const file of updated) {
			console.log(`- ${file}`);
		}
	}

	if (cargoUpdated.length > 0) {
		console.log(`Aligned ${cargoUpdated.length} Cargo.toml files to ${targetVersion}:`);
		for (const file of cargoUpdated) {
			console.log(`- ${file}`);
		}
	}

	if (resolved.length > 0) {
		console.log(`Resolved workspace: protocols in ${resolved.length} publishable package(s):`);
		for (const file of resolved) {
			console.log(`- ${file}`);
		}
	}

	if (forgeManifestUpdated.length > 0) {
		console.log(`Synced Forge manifest copies from ${FORGE_VERSION_FILE}:`);
		for (const file of forgeManifestUpdated) {
			console.log(`- ${file}`);
		}
	}
}

if (import.meta.main) {
	main();
}
