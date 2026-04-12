#!/usr/bin/env bun

import { execSync } from "node:child_process";
import { readFileSync } from "node:fs";

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
	const output = execSync("git ls-files package.json 'packages/**/package.json'", {
		encoding: "utf8",
	});

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

export function getManifestTargets(argv: readonly string[]): string[] {
	return argv.length > 0 ? [...argv] : listPublishableManifestTargets();
}

function main(): void {
	const targets = getManifestTargets(process.argv.slice(2));
	const workspacePackages = collectWorkspacePackages();
	const issues = collectManifestIssues(targets, workspacePackages);

	if (issues.length > 0) {
		console.error(formatIssues(issues));
		process.exit(1);
	}

	console.log(`Publish manifest check passed for ${targets.length} package(s).`);
}

if (import.meta.main) {
	main();
}
