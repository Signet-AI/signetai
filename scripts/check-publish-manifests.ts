#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { existsSync, readFileSync, statSync } from "node:fs";

const RUNTIME_FIELDS = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

type RuntimeField = (typeof RUNTIME_FIELDS)[number];

type PackageJson = {
	readonly name?: unknown;
	readonly private?: unknown;
	readonly publishConfig?: unknown;
	readonly dependencies?: unknown;
	readonly optionalDependencies?: unknown;
	readonly peerDependencies?: unknown;
};

type WorkspacePackage = {
	readonly file: string;
	readonly name: string;
	readonly publishable: boolean;
};

type ManifestIssue = {
	readonly file: string;
	readonly packageName: string;
	readonly field: RuntimeField;
	readonly dep: string;
	readonly spec: string;
	readonly reason: string;
};

type NativeManifestIssue = {
	readonly file: string;
	readonly reason: string;
};

type NativeManifestAsset = {
	readonly name?: unknown;
	readonly platform?: unknown;
	readonly sha256?: unknown;
	readonly size?: unknown;
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function readPackageJson(file: string): PackageJson {
	return JSON.parse(readFileSync(file, "utf8")) as PackageJson;
}

function getPackageName(file: string, pkg: PackageJson): string {
	if (typeof pkg.name !== "string" || pkg.name.length === 0) {
		throw new Error(`Missing package name in ${file}`);
	}

	return pkg.name;
}

export function isPublishableWorkspacePackage(pkg: PackageJson): boolean {
	if (pkg.private === true) return false;

	if (!isRecord(pkg.publishConfig)) return false;

	return pkg.publishConfig.access === "public";
}

export function listWorkspacePackageFiles(): string[] {
	const output = execSync(
		"git ls-files package.json 'platform/**/package.json' 'surfaces/**/package.json' 'integrations/**/package.json' 'libs/**/package.json' 'dist/**/package.json' 'web/**/package.json'",
		{
			encoding: "utf8",
		},
	);

	return output
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

export function collectWorkspacePackages(
	files: readonly string[] = listWorkspacePackageFiles(),
): Map<string, WorkspacePackage> {
	const packages = new Map<string, WorkspacePackage>();

	for (const file of files) {
		const pkg = readPackageJson(file);
		const name = getPackageName(file, pkg);
		packages.set(name, {
			file,
			name,
			publishable: isPublishableWorkspacePackage(pkg),
		});
	}

	return packages;
}

export function listPublishableManifestTargets(files: readonly string[] = listWorkspacePackageFiles()): string[] {
	return files.filter((file) => {
		const pkg = readPackageJson(file);
		return isPublishableWorkspacePackage(pkg);
	});
}

function getRuntimeDependencies(pkg: PackageJson, field: RuntimeField): Array<readonly [string, string]> {
	const value = pkg[field];
	if (!isRecord(value)) return [];

	return Object.entries(value).flatMap(([name, spec]) => (typeof spec === "string" ? ([[name, spec]] as const) : []));
}

export function collectManifestIssues(
	targets: readonly string[],
	workspacePackages: ReadonlyMap<string, WorkspacePackage>,
): ManifestIssue[] {
	const issues: ManifestIssue[] = [];

	for (const file of targets) {
		const pkg = readPackageJson(file);
		const packageName = getPackageName(file, pkg);

		for (const field of RUNTIME_FIELDS) {
			for (const [dep, spec] of getRuntimeDependencies(pkg, field)) {
				if (spec.startsWith("workspace:")) {
					issues.push({
						file,
						packageName,
						field,
						dep,
						spec,
						reason: "runtime dependency still uses workspace protocol",
					});
					continue;
				}

				const workspaceDep = workspacePackages.get(dep);
				if (workspaceDep && !workspaceDep.publishable) {
					issues.push({
						file,
						packageName,
						field,
						dep,
						spec,
						reason: `depends on internal workspace package ${dep}, which is not published`,
					});
				}
			}
		}
	}

	return issues;
}

function formatIssues(issues: readonly ManifestIssue[]): string {
	const lines = issues.map(
		(issue) => `- ${issue.file} (${issue.packageName}) ${issue.field}.${issue.dep}=${issue.spec} -> ${issue.reason}`,
	);

	return `Publish manifest validation failed:\n${lines.join("\n")}`;
}

function formatNativeManifestIssues(issues: readonly NativeManifestIssue[]): string {
	const lines = issues.map((issue) => `- ${issue.file} -> ${issue.reason}`);
	return `Native manifest validation failed:\n${lines.join("\n")}`;
}

export function parseSupportedNativePlatforms(installerSource: string): string[] {
	const match = installerSource.match(/export const nativePlatforms = \{([\s\S]*?)\n\s*\};/);
	if (!match) return [];

	return Array.from(match[1].matchAll(/^\s*"([^"]+)":/gm), ([, platform]) => platform).sort();
}

export function collectNativeManifestIssues(
	manifest: unknown,
	supportedPlatforms: readonly string[],
	file = "dist/native/native-manifest.json",
): NativeManifestIssue[] {
	const issues: NativeManifestIssue[] = [];
	if (!isRecord(manifest)) {
		return [{ file, reason: "manifest is not a JSON object" }];
	}

	if (manifest.schemaVersion !== 1) {
		issues.push({ file, reason: "schemaVersion must be 1" });
	}

	if (typeof manifest.version !== "string" || manifest.version.length === 0) {
		issues.push({ file, reason: "version must be a non-empty string" });
	}

	if (!Array.isArray(manifest.assets)) {
		issues.push({ file, reason: "assets must be an array" });
		return issues;
	}

	const assets = manifest.assets as NativeManifestAsset[];
	const seen = new Set<string>();
	for (const asset of assets) {
		if (!isRecord(asset)) {
			issues.push({ file, reason: "asset entries must be objects" });
			continue;
		}

		const platform = asset.platform;
		const name = asset.name;
		if (typeof platform !== "string" || platform.length === 0) {
			issues.push({ file, reason: "asset platform must be a non-empty string" });
			continue;
		}
		if (seen.has(platform)) {
			issues.push({ file, reason: `duplicate asset platform ${platform}` });
		}
		seen.add(platform);

		const expectedName = platform.startsWith("win32-") ? `signet-${platform}.exe` : `signet-${platform}`;
		if (name !== expectedName) {
			issues.push({ file, reason: `asset ${platform} name must be ${expectedName}` });
		}

		if (typeof asset.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(asset.sha256)) {
			issues.push({ file, reason: `asset ${platform} sha256 must be a lowercase SHA-256 hex digest` });
		}

		if (typeof asset.size !== "number" || !Number.isInteger(asset.size) || asset.size <= 0) {
			issues.push({ file, reason: `asset ${platform} size must be a positive integer` });
		}
	}

	const actualPlatforms = [...seen].sort();
	const expectedPlatforms = [...supportedPlatforms].sort();
	if (actualPlatforms.join("\n") !== expectedPlatforms.join("\n")) {
		issues.push({
			file,
			reason: `platforms must match npm wrapper support: expected ${expectedPlatforms.join(", ")}, got ${actualPlatforms.join(", ")}`,
		});
	}

	return issues;
}

function packageNameToNativePlatform(packageName: string): string | null {
	const prefix = "@signetai/signetai-";
	return packageName.startsWith(prefix) ? packageName.slice(prefix.length) : null;
}

export function collectNativePackageIssues(targets: readonly string[]): NativeManifestIssue[] {
	const issues: NativeManifestIssue[] = [];
	for (const file of targets) {
		const pkg = readPackageJson(file);
		const packageName = getPackageName(file, pkg);
		const platform = packageNameToNativePlatform(packageName);
		if (!platform) continue;

		const binaryName = platform.startsWith("win32-") ? "signet.exe" : "signet";
		const binaryFile = file.replace(/package\.json$/, `bin/${binaryName}`);
		if (!existsSync(binaryFile)) {
			issues.push({ file, reason: `missing staged native binary ${binaryFile}` });
			continue;
		}
		if (!statSync(binaryFile).isFile()) {
			issues.push({ file, reason: `staged native binary is not a file: ${binaryFile}` });
		}
	}

	return issues;
}

export function getManifestTargets(argv: readonly string[]): string[] {
	return argv.length > 0 ? [...argv] : listPublishableManifestTargets();
}

function main(): void {
	const targets = getManifestTargets(process.argv.slice(2));
	const workspacePackages = collectWorkspacePackages();
	const issues = collectManifestIssues(targets, workspacePackages);
	const nativeManifestIssues =
		targets.includes("dist/signetai/package.json") && !process.env.SIGNET_SKIP_NATIVE_MANIFEST_CHECK
			? collectNativeManifestIssues(
					existsSync("dist/native/native-manifest.json")
						? JSON.parse(readFileSync("dist/native/native-manifest.json", "utf8"))
						: null,
					parseSupportedNativePlatforms(readFileSync("dist/signetai/bin/native-platforms.js", "utf8")),
				)
			: [];
	const nativePackageIssues = collectNativePackageIssues(targets);

	if (issues.length > 0 || nativeManifestIssues.length > 0 || nativePackageIssues.length > 0) {
		if (issues.length > 0) console.error(formatIssues(issues));
		if (nativeManifestIssues.length > 0) console.error(formatNativeManifestIssues(nativeManifestIssues));
		if (nativePackageIssues.length > 0) console.error(formatNativeManifestIssues(nativePackageIssues));
		process.exit(1);
	}

	console.log(`Publish manifest check passed for ${targets.length} package(s).`);
}

if (import.meta.main) {
	main();
}
