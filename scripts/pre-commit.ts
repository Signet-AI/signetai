#!/usr/bin/env bun

import { join, posix, resolve } from "node:path";

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
const SHARED_ROOT_FILES = new Set(["biome.json", "bunfig.toml", "bun.lock", "package.json", "tsconfig.json"]);
const ROOT_TOOLING_PREFIXES = ["scripts/", "tests/"] as const;
const BUILD_EXCLUDED_WORKSPACES = new Set([
	"@signet/daemon",
	"@signet/desktop",
	"@signet/tray",
	"@signet/extension",
	"signet-dashboard",
	"@signet/docs",
	"@signet/web",
]);

export interface WorkspaceInfo {
	readonly dir: string;
	readonly hasBuild: boolean;
	readonly hasTypecheck: boolean;
	readonly name: string;
	readonly version: string;
	readonly workspaceDependencies: readonly string[];
}

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

export function isBiomeCandidate(file: string): boolean {
	const normalized = file.replaceAll("\\", "/");
	const extension = BIOME_EXTENSIONS.find((candidate) => normalized.endsWith(candidate));
	if (extension === undefined) return false;
	return !normalized.split("/").some((part) => BIOME_EXCLUDED_PARTS.has(part));
}

function stringRecord(value: unknown): Readonly<Record<string, string>> {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return {};
	const entries: Array<[string, string]> = [];
	for (const [key, entry] of Object.entries(value)) {
		if (typeof entry === "string") entries.push([key, entry]);
	}
	return Object.fromEntries(entries);
}

function field(record: unknown, name: string): unknown {
	if (typeof record !== "object" || record === null || Array.isArray(record)) return undefined;
	const entries: ReadonlyArray<readonly [string, unknown]> = Object.entries(record);
	return entries.find(([key]) => key === name)?.[1];
}

async function readJson(path: string): Promise<unknown> {
	const parsed: unknown = JSON.parse(await Bun.file(path).text());
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Expected a JSON object in ${path}`);
	}
	return parsed;
}

function manifestName(manifest: unknown, label: string): string {
	const name = field(manifest, "name");
	if (typeof name !== "string" || name.length === 0) {
		throw new Error(`Missing package name in ${label}`);
	}
	return name;
}
export function isWorkspaceSpec(spec: string, memberVersion: string): boolean {
	return spec.startsWith("workspace:") || spec === memberVersion;
}

function workspaceDependencyEdges(
	manifest: unknown,
	memberVersionOf: (name: string) => string | undefined,
): readonly string[] {
	const dependencies = stringRecord(field(manifest, "dependencies"));
	const devDependencies = stringRecord(field(manifest, "devDependencies"));
	const optionalDependencies = stringRecord(field(manifest, "optionalDependencies"));
	return [...Object.entries(dependencies), ...Object.entries(devDependencies), ...Object.entries(optionalDependencies)]
		.filter(([name, spec]) => {
			const memberVersion = memberVersionOf(name);
			return memberVersion !== undefined && isWorkspaceSpec(spec, memberVersion);
		})
		.map(([name]) => name);
}

async function workspaceDirectories(patterns: readonly string[]): Promise<readonly string[]> {
	const directories = new Set<string>();
	for (const pattern of patterns) {
		const glob = new Bun.Glob(`${pattern}/package.json`);
		for await (const file of glob.scan({ cwd: ROOT, dot: true, onlyFiles: true })) {
			directories.add(posix.dirname(file));
		}
	}
	return [...directories].sort();
}

export async function readWorkspaces(): Promise<readonly WorkspaceInfo[]> {
	const manifest = await readJson(join(ROOT, "package.json"));
	const patterns = field(manifest, "workspaces");
	const directories = await workspaceDirectories(
		Array.isArray(patterns) ? patterns.filter((entry): entry is string => typeof entry === "string") : [],
	);
	const packages = new Map<string, { dir: string; name: string; version: string }>();
	for (const dir of directories) {
		const label = `${dir}/package.json`;
		const pkg = await readJson(join(ROOT, dir, "package.json"));
		const name = manifestName(pkg, label);
		const version = field(pkg, "version");
		packages.set(dir, {
			dir,
			name,
			version: typeof version === "string" ? version : "",
		});
	}
	const nameToPackage = new Map([...packages.values()].map((entry) => [entry.name, entry]));
	const workspaces: WorkspaceInfo[] = [];
	for (const dir of directories) {
		const entry = packages.get(dir);
		if (entry === undefined) continue;
		const pkg = await readJson(join(ROOT, dir, "package.json"));
		const scripts = stringRecord(field(pkg, "scripts"));
		workspaces.push({
			dir,
			hasBuild: typeof scripts.build === "string",
			hasTypecheck: typeof scripts.typecheck === "string",
			name: entry.name,
			version: entry.version,
			workspaceDependencies: workspaceDependencyEdges(pkg, (memberName) => nameToPackage.get(memberName)?.version),
		});
	}
	return workspaces;
}

function matchWorkspace(normalizedFile: string, workspaces: readonly WorkspaceInfo[]): WorkspaceInfo | undefined {
	let selected: WorkspaceInfo | undefined;
	for (const workspace of workspaces) {
		if (!normalizedFile.startsWith(`${workspace.dir}/`)) continue;
		if (selected === undefined || workspace.dir.length > selected.dir.length) selected = workspace;
	}
	return selected;
}

export function typecheckCandidates(
	files: readonly string[],
	workspaces: readonly WorkspaceInfo[],
): ReadonlySet<string> {
	const targets = new Set<string>();
	for (const file of files) {
		const normalized = file.replaceAll("\\", "/");
		const shared =
			SHARED_ROOT_FILES.has(normalized) || ROOT_TOOLING_PREFIXES.some((prefix) => normalized.startsWith(prefix));
		if (shared) {
			return new Set(workspaces.filter((workspace) => workspace.hasTypecheck).map((workspace) => workspace.name));
		}
		if (!isBiomeCandidate(normalized)) continue;
		const owner = matchWorkspace(normalized, workspaces);
		if (owner === undefined || !owner.hasTypecheck) continue;
		targets.add(owner.name);
	}
	return targets;
}
export function buildClosure(
	targetNames: readonly string[],
	workspaces: readonly WorkspaceInfo[],
): ReadonlySet<string> {
	const byName = new Map(workspaces.map((workspace) => [workspace.name, workspace]));
	const closure = new Set<string>();
	const queue = [...targetNames];
	while (queue.length > 0) {
		const name = queue.pop();
		if (name === undefined) continue;
		const workspace = byName.get(name);
		if (workspace === undefined || closure.has(name)) continue;
		closure.add(name);
		for (const dependency of workspace.workspaceDependencies) {
			if (!closure.has(dependency)) queue.push(dependency);
		}
	}
	return closure;
}
export function buildOrder(closure: ReadonlySet<string>, workspaces: readonly WorkspaceInfo[]): readonly string[] {
	const buildable = workspaces.filter(
		(workspace) => closure.has(workspace.name) && workspace.hasBuild && !BUILD_EXCLUDED_WORKSPACES.has(workspace.name),
	);
	const buildableNames = new Set(buildable.map((workspace) => workspace.name));
	const prerequisites = new Map(
		buildable.map((workspace) => [
			workspace.name,
			workspace.workspaceDependencies.filter((dependency) => buildableNames.has(dependency)),
		]),
	);
	const order: string[] = [];
	const built = new Set<string>();
	let progress = true;
	while (progress) {
		progress = false;
		for (const name of [...prerequisites.keys()].sort()) {
			if (built.has(name)) continue;
			const pending = prerequisites.get(name)?.some((dependency) => !built.has(dependency)) ?? false;
			if (pending) continue;
			order.push(name);
			built.add(name);
			progress = true;
		}
	}
	return order;
}

function buildFilterArgs(names: readonly string[]): readonly string[] {
	const args: string[] = [];
	for (const name of names) args.push("--filter", name);
	return args;
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

	const files = stagedFiles();
	if (files.length === 0) {
		console.log("No staged files; skipping staged Biome validation and scoped typechecks");
		return;
	}

	if (files.some(isBiomeCandidate)) {
		const biome = await run("Running staged Biome validation", ["bun", "run", "biome", "check", "--staged"]);
		if (biome !== 0) {
			process.exitCode = biome;
			return;
		}
	} else {
		console.log("No Biome-supported staged files; skipping staged Biome validation");
	}

	const workspaces = await readWorkspaces();
	const targets = [...typecheckCandidates(files, workspaces)].sort();
	if (targets.length === 0) {
		console.log("No affected workspace typechecks; skipping TypeScript validation (full check remains in CI)");
		return;
	}

	console.log(
		`Running typechecks for ${targets.length} affected workspace${targets.length === 1 ? "" : "s"}: ${targets.join(", ")}`,
	);
	const closure = buildClosure(targets, workspaces);
	const builds = buildOrder(closure, workspaces);
	if (builds.length > 0) {
		const label = `Building ${builds.length} required workspace package${builds.length === 1 ? "" : "s"}`;
		const build = await run(label, ["bun", "run", ...buildFilterArgs(builds), "build"]);
		if (build !== 0) {
			console.error("Required workspace build failed; fix the build before committing.");
			process.exitCode = build;
			return;
		}
	}
	process.exitCode = await run("Running affected workspace typechecks", [
		"bun",
		"run",
		...buildFilterArgs(targets),
		"typecheck",
	]);
}

if (import.meta.main) await main();
