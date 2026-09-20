import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export const BASELINE_SHA = "11e4720c07107caf7fdd57a685eca24e8a82e654";
export const CORPUS_SIZE = 497;
export type Backend = "typescript" | "rust";
export type ManifestEntry = { path: string; sha256: string };
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
function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

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
	const all = String(git(repo, ["ls-tree", "-r", "--name-only", BASELINE_SHA]))
		.split("\n")
		.filter(Boolean);
	const paths = discoverPaths(all);
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
		for (const entry of entries)
			if (current.get(entry.path) !== entry.sha256) throw new Error(`hash mismatch for ${entry.path}`);
}

export function validateBaselineWorktree(worktree: string): void {
	if (!existsSync(worktree) || !statSync(worktree).isDirectory())
		throw new Error("typescript lane requires a pinned baseline worktree");
	let head: string;
	try {
		head = String(git(worktree, ["rev-parse", "HEAD"])).trim();
	} catch {
		throw new Error("typescript lane requires a pinned baseline worktree");
	}
	if (head !== BASELINE_SHA) throw new Error(`typescript worktree must be pinned at ${BASELINE_SHA}`);
}

export function validateLaneOptions(
	backend: Backend,
	options: { worktree?: string; artifact?: string; adapter?: string; report?: string },
): void {
	if (backend === "typescript") {
		if (!options.worktree) throw new Error("typescript lane requires an explicit pinned reference worktree");
		validateBaselineWorktree(options.worktree);
	} else {
		if (!options.artifact || !existsSync(options.artifact) || !statSync(options.artifact).isFile())
			throw new Error("rust lane requires a real Rust artifact");
		if (!options.adapter || !existsSync(options.adapter) || !statSync(options.adapter).isFile())
			throw new Error("rust lane requires a faithful adapter");
		if (!options.report) throw new Error("rust lane requires a report location");
	}
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

export function parseJUnitReport(xml: string, paths: string[]): Accounting {
	const cases = [...xml.matchAll(/<testcase\b[^>]*?(?:\/>|>[\s\S]*?<\/testcase>)/g)].map((m) => m[0]);
	if (!cases.length) throw new Error("JUnit report has no testcase accounting");
	const failed = cases.filter((c) => /<(?:failure|error)\b/.test(c)).length;
	const skipped = cases.filter((c) => /<skipped\b/.test(c)).length;
	if (cases.length < paths.length) throw new Error("JUnit report has incomplete testcase accounting");
	return {
		tests: cases.length,
		passed: cases.length - failed - skipped,
		failed,
		skipped,
		crash: false,
		incomplete: cases.length !== paths.length,
	};
}

export function run(
	repo: string,
	backend: Backend,
	options: { worktree?: string; artifact?: string; adapter?: string; report?: string; paths?: string[] },
): Record<string, unknown> {
	validateLaneOptions(backend, options);
	const manifest = discoverBaseline(repo);
	validateManifest(manifest, currentManifest(repo, manifest));
	const paths = options.paths ?? manifest.map((e) => e.path);
	if (paths.length !== CORPUS_SIZE || paths.some((p) => !manifest.some((e) => e.path === p)))
		throw new Error("selected paths must be the exact baseline corpus");
	const report = options.report ?? resolve(repo, `.shared-corpus-${backend}.xml`);
	const adapter = options.adapter ?? "";
	const artifact = options.artifact ?? "";
	const command =
		backend === "typescript"
			? ["bun", "test", "--reporter=junit", `--reporter-outfile=${report}`, "--timeout=5000", ...paths]
			: [
					adapter,
					"--artifact",
					artifact,
					"--manifest",
					JSON.stringify(manifest),
					"--report",
					report,
					"--timeout",
					"5000",
					...paths,
				];
	const executable = command[0];
	if (!executable) throw new Error("lane command is empty");
	const child = spawnSync(executable, command.slice(1), {
		cwd: backend === "typescript" ? options.worktree : repo,
		env: { ...process.env },
		encoding: "utf8",
	});
	if (!existsSync(report)) throw new Error(`${backend} lane did not produce a report`);
	const accounting = parseJUnitReport(readFileSync(report, "utf8"), paths);
	if (child.status !== 0 && !accounting.failed && !accounting.crash)
		throw new Error(`${backend} lane exited unsuccessfully without accounted failures`);
	return {
		baselineSha: BASELINE_SHA,
		backend,
		worktree: backend === "typescript" ? options.worktree : null,
		artifact: backend === "rust" ? options.artifact : null,
		discovered: manifest.length,
		selected: paths.length,
		command,
		...accounting,
		status: accounting.crash ? "crash" : accounting.failed ? "failed" : "passed",
	};
}

if (import.meta.main) {
	const args = Bun.argv.slice(2);
	const value = (f: string) => (args.includes(f) ? args[args.indexOf(f) + 1] : undefined);
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
