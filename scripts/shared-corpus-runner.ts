import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync, unlinkSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export const BASELINE_SHA = "11e4720c07107caf7fdd57a685eca24e8a82e654";
export const CORPUS_SIZE = 497;
export type Backend = "typescript" | "rust";
export type ManifestEntry = { path: string; sha256: string };
export type ExecutionManifest = {
	baselineSha: string;
	packageJsonSha256: string;
	roots: string[];
	filters: string[];
	excludedDisabledCases: string[];
	protectedCorpus: ManifestEntry[];
};
export type Accounting = {
	tests: number;
	passed: number;
	failed: number;
	skipped: number;
	crash: boolean;
	incomplete: boolean;
	status?: "passed" | "failed";
};

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
	const paths = discoverPaths(
		String(git(repo, ["ls-tree", "-r", "--name-only", BASELINE_SHA]))
			.split("\n")
			.filter(Boolean),
	);
	if (paths.length !== CORPUS_SIZE)
		throw new Error(`baseline corpus has ${paths.length} paths; expected ${CORPUS_SIZE}`);
	return paths.map((path) => ({
		path,
		sha256: sha256(git(repo, ["show", `${BASELINE_SHA}:${path}`], true) as Buffer),
	}));
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
	o: { worktree?: string; artifact?: string; adapter?: string; report?: string },
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
		if (!o.report) throw new Error("rust lane requires a report location");
	}
}
export function resolveReportPath(backend: Backend, _repo: string, report?: string): string | undefined {
	if (report) return resolve(report);
	return backend === "rust" ? undefined : undefined;
}
export function buildTypeScriptCommand(selected?: string[]): string[] {
	return selected ? ["bun", "run", "test:hermetic", ...selected] : ["bun", "run", "test:workspace"];
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
export function runnableSelectedPaths(paths: string[], manifest: ManifestEntry[]): string[] {
	const allowed = new Set(manifest.map((e) => e.path));
	const out = paths.filter((p) => allowed.has(p) && /(?:^|\/)[^/]+\.(?:test|spec)\.[^.]+$/.test(p));
	if (!out.length) throw new Error("selected mode requires valid test entrypoints");
	return [...new Set(out)].sort();
}
export function runnableManifestPaths(manifest: ManifestEntry[]): string[] {
	return manifest
		.map((e) => e.path)
		.filter((p) => /(?:^|\/)[^/]+\.(?:test|spec)\.[^.]+$/.test(p))
		.sort();
}
export function parseJUnitReport(xml: string, expected: string[] = [], childStatus: number | null = 0): Accounting {
	const cases = [...xml.matchAll(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g)].map((m) => m[0]);
	const suite = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? "";
	const suiteFailed =
		Number(suite.match(/failures="(\d+)"/)?.[1] ?? 0) + Number(suite.match(/errors="(\d+)"/)?.[1] ?? 0);
	if (!cases.length)
		return {
			tests: 0,
			passed: 0,
			failed: Math.max(1, suiteFailed),
			skipped: 0,
			crash: true,
			incomplete: true,
			status: "failed",
		};
	const failed = cases.filter((c) => /<(?:failure|error)\b/.test(c)).length;
	const skipped = cases.filter((c) => /<skipped\b/.test(c)).length;
	const identities = cases.map(
		(c) => `${c.match(/classname="([^"]*)"/)?.[1] ?? ""}\0${c.match(/name="([^"]*)"/)?.[1] ?? ""}`,
	);
	const duplicate = new Set(identities).size !== identities.length;
	const declared = Number(suite.match(/tests="(\d+)"/)?.[1] ?? cases.length);
	const incomplete = duplicate || declared !== cases.length || (expected.length > 0 && cases.length < expected.length);
	const crashed = childStatus !== 0;
	return {
		tests: cases.length,
		passed: cases.length - failed - skipped,
		failed: failed + Math.max(0, suiteFailed - failed) + (duplicate ? 1 : 0),
		skipped,
		crash: crashed || duplicate,
		incomplete: incomplete || crashed,
		status: crashed || duplicate || failed > 0 || incomplete ? "failed" : "passed",
	};
}

export function run(
	repo: string,
	backend: Backend,
	o: { worktree?: string; artifact?: string; adapter?: string; report?: string; paths?: string[] },
): Record<string, unknown> {
	validateLaneOptions(backend, o);
	const manifest = buildExecutionManifest(repo);
	validateManifest(manifest.protectedCorpus, currentManifest(repo, manifest.protectedCorpus));
	const selected = o.paths ? runnableSelectedPaths(o.paths, manifest.protectedCorpus) : undefined;
	const expected = selected ?? runnableManifestPaths(manifest.protectedCorpus);
	const report = resolveReportPath(backend, repo, o.report);
	const command =
		backend === "typescript"
			? buildTypeScriptCommand(selected)
			: [
					o.adapter ?? "",
					"--artifact",
					o.artifact ?? "",
					"--manifest",
					JSON.stringify(manifest),
					"--paths",
					JSON.stringify(expected),
					"--report",
					report ?? "",
				];
	const executable = command[0];
	if (!executable) throw new Error("lane command is empty");
	if (report && existsSync(report)) unlinkSync(report);
	const child = spawnSync(executable, command.slice(1), {
		cwd: backend === "typescript" ? o.worktree : repo,
		env: { ...process.env },
		encoding: "utf8",
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
	const accounting = parseJUnitReport(readFileSync(report, "utf8"), selected ?? [], child.status);
	const crash = child.status !== 0 || child.signal !== null;
	const incomplete = accounting.incomplete || accounting.tests === 0;
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
		crash,
		incomplete,
		status: crash || accounting.failed || incomplete ? "failed" : "passed",
	};
}
if (import.meta.main) {
	const a = Bun.argv.slice(2);
	const value = (f: string) => (a.includes(f) ? a[a.indexOf(f) + 1] : undefined);
	const backend = value("--backend") as Backend;
	if (backend !== "typescript" && backend !== "rust") throw new Error("--backend must be typescript or rust");
	console.log(
		JSON.stringify(
			run(resolve("."), backend, {
				worktree: value("--worktree"),
				artifact: value("--artifact"),
				adapter: value("--adapter"),
				report: value("--report"),
				paths: value("--paths") ? JSON.parse(value("--paths") as string) : undefined,
			}),
		),
	);
}
