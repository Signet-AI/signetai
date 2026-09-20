import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
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
export function validateManifest(entries: ManifestEntry[], current?: Map<string, string>): void {
	if (entries.length !== CORPUS_SIZE) throw new Error(`manifest must contain ${CORPUS_SIZE} paths`);
	if (new Set(entries.map((e) => e.path)).size !== entries.length) throw new Error("manifest contains duplicate paths");
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
		if (!o.adapter || !existsSync(o.adapter) || !statSync(o.adapter).isFile())
			throw new Error("rust lane requires a faithful adapter");
		if (!o.report) throw new Error("rust lane requires a report location");
	}
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
export function parseJUnitReport(xml: string, expected: string[] = []): Accounting {
	const cases = [...xml.matchAll(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g)].map((m) => m[0]);
	const suite = xml.match(/<testsuite\b[^>]*>/)?.[0] ?? "";
	const suiteFailed =
		Number(suite.match(/failures="(\d+)"/)?.[1] ?? 0) + Number(suite.match(/errors="(\d+)"/)?.[1] ?? 0);
	if (!cases.length) return { tests: 0, passed: 0, failed: suiteFailed, skipped: 0, crash: true, incomplete: true };
	const failed = cases.filter((c) => /<(?:failure|error)\b/.test(c)).length;
	const skipped = cases.filter((c) => /<skipped\b/.test(c)).length;
	return {
		tests: cases.length,
		passed: cases.length - failed - skipped,
		failed: failed + Math.max(0, suiteFailed - failed),
		skipped,
		crash: false,
		incomplete: expected.length > 0 && cases.length < expected.length,
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
	const command =
		backend === "typescript"
			? ["bun", "run", "test:workspace"]
			: [
					o.adapter ?? "",
					"--artifact",
					o.artifact ?? "",
					"--manifest",
					JSON.stringify(manifest),
					"--report",
					o.report ?? "",
				];
	const executable = command[0];
	if (!executable) throw new Error("lane command is empty");
	const child = spawnSync(executable, command.slice(1), {
		cwd: backend === "typescript" ? o.worktree : repo,
		env: { ...process.env },
		encoding: "utf8",
	});
	if (!o.report || !existsSync(o.report)) throw new Error(`${backend} lane did not produce a report`);
	const accounting = parseJUnitReport(readFileSync(o.report, "utf8"), selected ?? []);
	const crash = child.status !== 0 && accounting.tests === 0;
	return {
		baselineSha: BASELINE_SHA,
		backend,
		execution: selected ? "supplementary-selected" : "full-baseline-selection",
		manifest,
		command,
		...accounting,
		crash,
		status: crash || accounting.crash ? "crash" : accounting.failed || accounting.incomplete ? "failed" : "passed",
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
			}),
		),
	);
}
