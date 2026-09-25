import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import {
	resolveJUnitCaseIdentities,
	type JUnitCaseIdentity,
	type JUnitIdentityCollision,
	type SuiteHookIdentity,
} from "./shared-corpus-identities";

export const BASELINE_SHA = "11e4720c07107caf7fdd57a685eca24e8a82e654";
export const CORPUS_SIZE = 497;
export type Backend = "typescript" | "rust";
export type RustEvidenceScope = "combined" | "core" | "daemon";
export type ManifestEntry = { path: string; sha256: string };
export type ExecutionManifest = {
	baselineSha: string;
	packageJsonSha256: string;
	roots: string[];
	filters: string[];
	excludedDisabledCases: string[];
	protectedCorpus: ManifestEntry[];
};
export type NativeEvidenceScope = "none" | "batch" | "per-case";
export type Accounting = {
	tests: number;
	passed: number;
	failed: number;
	suiteFailures: number;
	skipped: number;
	reportedRecords: number;
	suiteHookMarkers: number;
	suiteHookIdentities: SuiteHookIdentity[];
	caseIdentities: JUnitCaseIdentity[];
	unresolvedIdentityCount: number;
	missingFiles: string[];
	unreportedFiles: string[];
	unexpectedFiles: string[];
	identityCollisions: JUnitIdentityCollision[];
	nativeEvidence: boolean;
	nativeEvidenceScope: NativeEvidenceScope;
	crash: boolean;
	incomplete: boolean;
	status?: "passed" | "failed";
};

export type CaseBackendEvidence = {
	identity: string;
	file: string;
	line?: string;
	sourceSha256?: string | null;
	status?: JUnitCaseIdentity["status"];
	backend: "typescript" | "rust" | "unverified";
};

export function caseCoverageIncomplete(backend: Backend, cases: readonly CaseBackendEvidence[]): boolean {
	return backend === "rust" && (cases.length === 0 || cases.some((entry) => entry.backend !== "rust"));
}

export function requiresNativeEvidence(backend: Backend, scope: NativeEvidenceScope): boolean {
	return backend === "rust" && scope !== "per-case";
}

/**
 * Supplementary proof runs may target one implementation boundary at a time.
 * The complete corpus remains a combined proof and must exercise both native
 * boundaries; a selected direct-core or daemon run only claims the boundary
 * its selected paths can legitimately exercise.
 */
export function rustEvidenceScope(selected?: readonly string[]): RustEvidenceScope {
	if (!selected || selected.length === 0) return "combined";
	if (selected.every((path) => path.startsWith("platform/core/"))) return "core";
	if (selected.every((path) => path.startsWith("platform/daemon/"))) return "daemon";
	return "combined";
}

function git(repo: string, args: string[], binary = false): string | Buffer {
	const r = spawnSync("git", args, { cwd: repo, encoding: binary ? "buffer" : "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
}
const sha256 = (data: string | Uint8Array) => createHash("sha256").update(data).digest("hex");

export const BASELINE_ROOTS = [
	"scripts",
	"tests",
	"platform/core",
	"platform/daemon",
	"platform/native",
	"surfaces/cli",
	"surfaces/dashboard",
	"surfaces/desktop",
	"surfaces/tray",
	"integrations",
	"libs",
	"memorybench",
	"web/workers",
];
export const BASELINE_FILTERS = ["@signet/codex-plugin"];
export const PREEXISTING_DISABLED_CASES: string[] = [];

export function discoverPaths(paths: string[]): string[] {
	return [
		...new Set(
			paths.filter(
				(p) =>
					/(?:^|\/)(?:test|tests|__tests__)(?:\/|$)/.test(p) ||
					/(?:^|\/)[^/]+\.(?:test|spec)\.[^.]+$/.test(p) ||
					p === "scripts/load-test-daemon.ts",
			),
		),
	].sort();
}
export function discoverBaseline(repo: string): ManifestEntry[] {
	const paths = discoverBaselinePaths(repo);
	return paths.map((path) => ({
		path,
		sha256: sha256(git(repo, ["show", `${BASELINE_SHA}:${path}`], true) as Buffer),
	}));
}
export function discoverBaselinePaths(repo: string): string[] {
	const paths = discoverPaths(
		String(git(repo, ["ls-tree", "-r", "--name-only", BASELINE_SHA]))
			.split("\n")
			.filter(Boolean),
	);
	if (paths.length !== CORPUS_SIZE)
		throw new Error(`baseline corpus has ${paths.length} paths; expected ${CORPUS_SIZE}`);
	return paths;
}
export function validateManifest(
	entries: ManifestEntry[],
	current?: Map<string, string>,
	baseline?: ManifestEntry[],
): void {
	if (entries.length !== CORPUS_SIZE) throw new Error(`manifest must contain ${CORPUS_SIZE} paths`);
	if (new Set(entries.map((e) => e.path)).size !== entries.length) throw new Error("manifest contains duplicate paths");
	if (baseline) {
		const expected = new Map(baseline.map((e) => [e.path, e.sha256]));
		for (const e of entries)
			if (expected.get(e.path) !== e.sha256) throw new Error(`manifest is not the pinned baseline: ${e.path}`);
	}
	if (current)
		for (const e of entries) if (current.get(e.path) !== e.sha256) throw new Error(`hash mismatch for ${e.path}`);
}
export function currentManifest(repo: string, entries: ManifestEntry[]): Map<string, string> {
	return new Map(
		entries.map((e) => {
			const p = resolve(repo, e.path);
			if (!existsSync(p)) throw new Error(`missing path ${e.path}`);
			return [e.path, sha256(readFileSync(p))];
		}),
	);
}
export function validateBaselineWorktree(worktree: string): void {
	if (!existsSync(worktree) || !statSync(worktree).isDirectory())
		throw new Error("typescript lane requires a pinned baseline worktree");
	let head = "";
	try {
		head = String(git(worktree, ["rev-parse", "HEAD"])).trim();
	} catch {}
	if (head !== BASELINE_SHA) throw new Error(`typescript worktree must be pinned at ${BASELINE_SHA}`);
}
export function validateLaneOptions(
	backend: Backend,
	o: {
		worktree?: string;
		artifact?: string;
		mcpArtifact?: string;
		coreDriver?: string;
		adapter?: string;
		report?: string;
	},
): void {
	if (backend === "typescript") {
		if (!o.worktree) throw new Error("typescript lane requires an explicit pinned reference worktree");
		validateBaselineWorktree(o.worktree);
	} else {
		if (!o.artifact || !existsSync(o.artifact) || !statSync(o.artifact).isFile())
			throw new Error("rust lane requires a real Rust artifact");
		if (
			!o.adapter ||
			!existsSync(o.adapter) ||
			!statSync(o.adapter).isFile() ||
			(statSync(o.adapter).mode & 0o111) === 0
		)
			throw new Error("rust lane requires a faithful executable adapter");
		if (!o.coreDriver || !existsSync(o.coreDriver) || !statSync(o.coreDriver).isFile())
			throw new Error("rust lane requires a real Rust core driver");
		if (!o.mcpArtifact || !existsSync(o.mcpArtifact) || !statSync(o.mcpArtifact).isFile())
			throw new Error("rust lane requires a real Rust MCP artifact");
		if (!o.report) throw new Error("rust lane requires a report location");
	}
}
export function resolveReportPath(backend: Backend, _repo: string, report?: string): string | undefined {
	if (report) return resolve(report);
	return backend === "rust" ? undefined : undefined;
}
export function clearReport(report?: string): void {
	if (report && existsSync(report)) unlinkSync(report);
}
export function buildTypeScriptCommand(selected?: string[], report?: string): string[] {
	if (selected && report)
		return ["bun", resolve(import.meta.dir, "typescript-shared-corpus-launcher.ts"), "--report", report, ...selected];
	return selected ? ["bun", "run", "test:hermetic", ...selected] : ["bun", "run", "test:workspace"];
}
export type TypeScriptSetupResult =
	| { status: "ready" }
	| { status: "failed"; step: "install" | "build"; exitCode: number | null };
export type SetupCommand = (command: string, args: string[], cwd: string, env: NodeJS.ProcessEnv) => number | null;

export function prepareTypeScriptLane(
	worktree: string,
	execute: SetupCommand = (command, args, cwd, env) => {
		const result = spawnSync(command, args, {
			cwd,
			env,
			encoding: "utf8",
			stdio: ["ignore", "pipe", "pipe"],
		});
		if (result.stdout) process.stderr.write(result.stdout);
		if (result.stderr) process.stderr.write(result.stderr);
		return result.status;
	},
	env: NodeJS.ProcessEnv = { ...process.env },
): TypeScriptSetupResult {
	for (const [step, args] of [
		["install", ["install", "--frozen-lockfile"]],
		["build", ["run", "build"]],
	] as const) {
		const exitCode = execute("bun", [...args], worktree, { ...env });
		if (exitCode !== 0) return { status: "failed", step, exitCode };
	}
	return { status: "ready" };
}

export function buildExecutionManifest(repo: string): ExecutionManifest {
	const packageJson = String(git(repo, ["show", `${BASELINE_SHA}:package.json`]));
	const pkg = JSON.parse(packageJson);
	const script = pkg.scripts?.["test:workspace"];
	const expected =
		"bun run build && bun run test:hermetic scripts tests platform/core platform/daemon platform/native surfaces/cli surfaces/dashboard surfaces/desktop surfaces/tray integrations libs memorybench web/workers && bun run --filter '@signet/codex-plugin' test";
	if (script !== expected) throw new Error("pinned baseline test:workspace script changed");
	return {
		baselineSha: BASELINE_SHA,
		packageJsonSha256: sha256(packageJson),
		roots: [...BASELINE_ROOTS],
		filters: [...BASELINE_FILTERS],
		excludedDisabledCases: [...PREEXISTING_DISABLED_CASES],
		protectedCorpus: discoverBaseline(repo),
	};
}
export function isTestEntrypoint(path: string): boolean {
	return /(?:^|\/)[^/]+\.(?:test|spec)\.[^.]+$/.test(path);
}
export function runnableSelectedPaths(paths: string[], manifest: ManifestEntry[]): string[] {
	if (new Set(paths).size !== paths.length) throw new Error("selected paths contain duplicates");
	const allowed = new Set(manifest.map((e) => e.path));
	const out = paths.filter((p) => allowed.has(p) && isTestEntrypoint(p));
	if (!out.length) throw new Error("selected mode requires valid test entrypoints");
	return [...new Set(out)].sort();
}
export function runnableManifestPaths(manifest: ManifestEntry[]): string[] {
	return manifest
		.map((e) => e.path)
		.filter(isTestEntrypoint)
		.sort();
}
export function parseJUnitReport(
	xml: string,
	expected: string[] = [],
	childStatus: number | null = 0,
	sourceRoot?: string,
): Accounting {
	const cases = [...xml.matchAll(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g)].map((match) => match[0]);
	const attribute = (source: string, name: string): string => {
		const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
		return source.match(new RegExp(`(?:^|\\s)${escaped}\\s*=\\s*(["'])(.*?)\\1`))?.[2] ?? "";
	};
	const nativeEvidence = [...xml.matchAll(/<testsuite\b[^>]*>/g)].some(
		(match) => attribute(match[0], "nativeEvidence") === "true",
	);
	const nativeEvidenceScope: NativeEvidenceScope = nativeEvidence ? "batch" : "none";
	const suiteStats = (() => {
		type Stats = { tests?: number; failures?: number; errors?: number };
		type SuiteNode = { kind: "testsuites" | "testsuite"; stats: Stats; childSuites: number };
		const suites: SuiteNode[] = [];
		const roots: SuiteNode[] = [];
		const stack: SuiteNode[] = [];
		const number = (attrs: string, name: string): number | undefined => {
			const value = attribute(attrs, name);
			return value === "" ? undefined : Number(value);
		};
		const tags = /<(testsuites|testsuite)\b([^>]*?)(\/?)>|<\/(testsuites|testsuite)\s*>/g;
		for (const match of xml.matchAll(tags)) {
			const opening = match[1] as "testsuites" | "testsuite" | undefined;
			if (opening) {
				const node: SuiteNode = {
					kind: opening,
					stats: {
						tests: number(match[2] ?? "", "tests"),
						failures: number(match[2] ?? "", "failures"),
						errors: number(match[2] ?? "", "errors"),
					},
					childSuites: 0,
				};
				const parent = stack.at(-1);
				if (parent) parent.childSuites += 1;
				else roots.push(node);
				if (node.kind === "testsuite") suites.push(node);
				if (match[3] !== "/") stack.push(node);
				continue;
			}
			const closing = match[4] as "testsuites" | "testsuite" | undefined;
			if (closing) {
				const index = stack.map((node) => node.kind).lastIndexOf(closing);
				if (index >= 0) stack.splice(index, 1);
			}
		}
		const leaves = suites.filter((suite) => suite.kind === "testsuite" && suite.childSuites === 0);
		const sum = (values: Array<number | undefined>): number | undefined => {
			const present = values.filter((value): value is number => value !== undefined);
			return present.length ? present.reduce((total, value) => total + value, 0) : undefined;
		};
		const failureCount = (stats: Stats): number | undefined =>
			stats.failures === undefined && stats.errors === undefined
				? undefined
				: (stats.failures ?? 0) + (stats.errors ?? 0);
		const rootStats = sum(roots.map((suite) => suite.stats.tests));
		const rootFailures = sum(roots.map((suite) => failureCount(suite.stats)));
		const leafTests = sum(leaves.map((suite) => suite.stats.tests));
		const leafFailures = sum(leaves.map((suite) => failureCount(suite.stats)));
		return {
			declared: leafTests ?? rootStats,
			failed: Math.max(leafFailures ?? 0, rootFailures ?? 0),
		};
	})();
	const identityResolution = resolveJUnitCaseIdentities(cases, sourceRoot);
	const caseIdentities = [...identityResolution.caseIdentities];
	const suiteHookIdentities = [...identityResolution.suiteHookIdentities];
	const suiteHookMarkers = suiteHookIdentities.length;
	const suiteFailures = Math.max(
		0,
		suiteStats.failed - cases.filter((testcase) => /<(?:failure|error)\b/.test(testcase)).length,
	);
	const failed = caseIdentities.filter((identity) => identity.status === "failed").length;
	const skipped = caseIdentities.filter((identity) => identity.status === "skipped").length;
	const hookFailures = suiteHookIdentities.filter((identity) => identity.status === "failed").length;
	const observedFiles = new Set(caseIdentities.map((identity) => identity.file).filter(Boolean));
	const expectedFiles = new Set(expected);
	const missingFiles = expected.length > 0 ? expected.filter((file) => !observedFiles.has(file)) : [];
	const unexpectedFiles = expected.length > 0 ? [...observedFiles].filter((file) => !expectedFiles.has(file)) : [];
	const declared = suiteStats.declared ?? cases.length;
	const adjustedDeclared = Math.max(0, declared - suiteHookMarkers);
	const tests = caseIdentities.length;
	const crashed = tests === 0 || (childStatus !== 0 && failed === 0 && suiteFailures === 0 && hookFailures === 0);
	const incomplete =
		declared !== cases.length ||
		adjustedDeclared !== tests ||
		cases.length === 0 ||
		missingFiles.length > 0 ||
		unexpectedFiles.length > 0 ||
		identityResolution.unresolvedIdentityCount > 0 ||
		identityResolution.identityCollisions.length > 0;
	return {
		tests,
		passed: Math.max(0, tests - failed - skipped),
		failed,
		suiteFailures,
		skipped,
		reportedRecords: cases.length,
		suiteHookMarkers,
		suiteHookIdentities,
		caseIdentities,
		unresolvedIdentityCount: identityResolution.unresolvedIdentityCount,
		missingFiles,
		unreportedFiles: [...missingFiles],
		unexpectedFiles,
		identityCollisions: [...identityResolution.identityCollisions],
		nativeEvidence,
		nativeEvidenceScope,
		crash: crashed,
		incomplete: incomplete || crashed,
		status: crashed || failed > 0 || suiteFailures > 0 || hookFailures > 0 || incomplete ? "failed" : "passed",
	};
}

export function run(
	repo: string,
	backend: Backend,
	o: {
		worktree?: string;
		artifact?: string;
		mcpArtifact?: string;
		coreDriver?: string;
		adapter?: string;
		report?: string;
		paths?: string[];
	},
): Record<string, unknown> {
	validateLaneOptions(backend, o);
	const manifest = buildExecutionManifest(repo);
	validateManifest(manifest.protectedCorpus, currentManifest(repo, manifest.protectedCorpus), manifest.protectedCorpus);
	if (backend === "typescript" && o.worktree) {
		const packageJsonPath = resolve(o.worktree, "package.json");
		if (!existsSync(packageJsonPath)) throw new Error("pinned baseline worktree is missing package.json");
		if (sha256(readFileSync(packageJsonPath)) !== manifest.packageJsonSha256)
			throw new Error("pinned baseline worktree package.json does not match the pinned baseline");
		validateManifest(
			manifest.protectedCorpus,
			currentManifest(o.worktree, manifest.protectedCorpus),
			manifest.protectedCorpus,
		);
	}
	const selected = o.paths ? runnableSelectedPaths(o.paths, manifest.protectedCorpus) : undefined;
	const expected = selected ?? runnableManifestPaths(manifest.protectedCorpus);
	const report = resolveReportPath(backend, repo, o.report);
	clearReport(report);
	const setup = backend === "typescript" ? prepareTypeScriptLane(o.worktree as string) : { status: "ready" as const };
	if (setup.status !== "ready") {
		return {
			baselineSha: BASELINE_SHA,
			backend,
			execution: selected ? "supplementary-selected" : "full-baseline-selection",
			manifest,
			command: buildTypeScriptCommand(selected, report),
			reportPath: report,
			worktree: o.worktree,
			tests: 0,
			passed: 0,
			failed: 0,
			skipped: 0,
			crash: true,
			incomplete: true,
			status: "failed",
			setup,
		};
	}
	const command =
		backend === "typescript"
			? buildTypeScriptCommand(selected ?? runnableManifestPaths(manifest.protectedCorpus), report)
			: [
					o.adapter ?? "",
					"--core-driver",
					o.coreDriver ?? "",
					"--artifact",
					o.artifact ?? "",
					"--manifest",
					JSON.stringify(manifest),
					"--paths",
					JSON.stringify(expected),
					"--report",
					report ?? "",
					"--scope",
					rustEvidenceScope(selected),
					"--mcp-artifact",
					o.mcpArtifact ?? "",
				];
	const executable = command[0];
	if (!executable) throw new Error("lane command is empty");
	clearReport(report);
	const child = spawnSync(executable, command.slice(1), {
		cwd: backend === "typescript" ? o.worktree : repo,
		env: { ...process.env },
		encoding: "utf8",
		maxBuffer: 32 * 1024 * 1024,
	});
	const fresh = report && existsSync(report);
	if (!fresh) {
		if (backend === "rust") throw new Error("rust lane did not produce a complete report");
		return {
			baselineSha: BASELINE_SHA,
			backend,
			execution: selected ? "supplementary-selected" : "full-baseline-selection",
			manifest,
			command,
			reportPath: report,
			worktree: o.worktree,
			tests: 0,
			passed: 0,
			failed: 0,
			skipped: 0,
			crash: child.status !== 0,
			incomplete: true,
			status: "incomplete",
		};
	}
	const accounting = parseJUnitReport(
		readFileSync(report, "utf8"),
		expected,
		child.status,
		backend === "typescript" ? o.worktree : repo,
	);
	const sourceHashes = new Map(manifest.protectedCorpus.map((entry) => [entry.path, entry.sha256]));
	const caseBackendEvidence: CaseBackendEvidence[] = accounting.caseIdentities.map((identity) => ({
		identity: identity.key,
		file: identity.file,
		line: identity.line,
		sourceSha256: sourceHashes.get(identity.file) ?? null,
		status: identity.status,
		backend: backend === "typescript" ? "typescript" : "unverified",
	}));
	const caseCoverageIsIncomplete = caseCoverageIncomplete(backend, caseBackendEvidence);
	const caseBackendCounts = {
		typescript: caseBackendEvidence.filter((evidence) => evidence.backend === "typescript").length,
		rust: caseBackendEvidence.filter((evidence) => evidence.backend === "rust").length,
		unverified: caseBackendEvidence.filter((evidence) => evidence.backend === "unverified").length,
	};
	const infrastructureCrash = child.signal !== null || child.error !== undefined;
	const nativeEvidenceGap = requiresNativeEvidence(backend, accounting.nativeEvidenceScope);
	const crash = infrastructureCrash || accounting.crash;
	const incomplete =
		accounting.incomplete ||
		accounting.tests === 0 ||
		infrastructureCrash ||
		nativeEvidenceGap ||
		caseCoverageIsIncomplete;
	return {
		baselineSha: BASELINE_SHA,
		backend,
		execution: selected ? "supplementary-selected" : "full-baseline-selection",
		manifest,
		command,
		reportPath: report,
		worktree: o.worktree,
		artifact: o.artifact,
		...accounting,
		caseBackendEvidence,
		caseBackendCounts,
		caseCoverageIncomplete: caseCoverageIsIncomplete,
		crash,
		incomplete,
		status:
			crash ||
			accounting.failed > 0 ||
			accounting.suiteFailures > 0 ||
			accounting.suiteHookIdentities.some((identity) => identity.status === "failed") ||
			incomplete
				? "failed"
				: "passed",
	};
}
if (import.meta.main) {
	const a = Bun.argv.slice(2);
	const value = (f: string) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined);
	const backend = value("--backend") as Backend;
	if (backend !== "typescript" && backend !== "rust") throw new Error("--backend must be typescript or rust");
	const result = run(resolve("."), backend, {
		worktree: value("--worktree"),
		artifact: value("--artifact"),
		adapter: value("--adapter"),
		coreDriver: value("--core-driver"),
		mcpArtifact: value("--mcp-artifact"),
		report: value("--report"),
		paths: value("--paths") ? JSON.parse(value("--paths") as string) : undefined,
	});
	console.log(JSON.stringify(result));
	if (result.status !== "passed") process.exitCode = 1;
}
