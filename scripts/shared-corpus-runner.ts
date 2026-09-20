import { createHash } from "node:crypto";
import { existsSync, readFileSync, statSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

export const BASELINE_SHA = "11e4720c07107caf7fdd57a685eca24e8a82e654";
export const CORPUS_SIZE = 497;
export type Backend = "typescript" | "rust";
export type ManifestEntry = { path: string; sha256: string };

function git(repo: string, args: string[]): string {
	const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
	if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
	return r.stdout;
}

export function discoverBaseline(repo: string): ManifestEntry[] {
	const paths = git(repo, ["ls-tree", "-r", "--name-only", BASELINE_SHA])
		.split("\n")
		.filter((p) => /(?:\.test|\.spec)\.(?:ts|tsx|js|jsx|mjs)$/.test(p));
	if (paths.length !== CORPUS_SIZE)
		throw new Error(`baseline corpus has ${paths.length} paths; expected ${CORPUS_SIZE}`);
	return paths.sort().map((path) => {
		const blob = git(repo, ["show", `${BASELINE_SHA}:${path}`]);
		return { path, sha256: sha256(blob) };
	});
}

function sha256(data: string | Uint8Array): string {
	return createHash("sha256").update(data).digest("hex");
}

export function validateManifest(entries: ManifestEntry[], current?: Map<string, string>): void {
	if (entries.length !== CORPUS_SIZE) throw new Error(`manifest must contain ${CORPUS_SIZE} paths`);
	if (new Set(entries.map((e) => e.path)).size !== entries.length) throw new Error("manifest contains duplicate paths");
	if (current)
		for (const entry of entries)
			if (current.get(entry.path) !== entry.sha256) throw new Error(`hash mismatch for ${entry.path}`);
}

export function validateLaneOptions(backend: Backend, options: { worktree?: string; artifact?: string }): void {
	if (backend === "typescript") {
		if (!options.worktree || !existsSync(options.worktree) || !statSync(options.worktree).isDirectory())
			throw new Error("typescript lane requires an explicit pinned reference worktree");
	} else if (!options.artifact || !existsSync(options.artifact) || !statSync(options.artifact).isFile())
		throw new Error("rust lane requires a real Rust artifact");
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

export function run(
	repo: string,
	backend: Backend,
	options: { worktree?: string; artifact?: string; paths?: string[] },
): Record<string, unknown> {
	validateLaneOptions(backend, options);
	const manifest = discoverBaseline(repo);
	validateManifest(manifest, currentManifest(repo, manifest));
	const paths = options.paths ?? manifest.map((e) => e.path);
	if (paths.some((p) => !manifest.some((e) => e.path === p)))
		throw new Error("selected path is not in baseline manifest");
	const cwd = backend === "typescript" ? options.worktree : repo;
	if (!cwd) throw new Error("typescript lane requires an explicit pinned reference worktree");
	const command = ["bun", "test", "--timeout=5000", ...paths];
	const env = { ...process.env, ...(backend === "rust" ? { SIGNET_RUST_DAEMON_BIN: options.artifact } : {}) };
	const child = spawnSync("bun", command.slice(1), { cwd, env, encoding: "utf8" });
	const status = child.status === 0 ? "passed" : child.signal ? "crash" : "failed";
	return {
		baselineSha: BASELINE_SHA,
		backend,
		worktree: cwd,
		artifact: backend === "rust" ? options.artifact : null,
		discovered: manifest.length,
		executed: paths.length,
		passed: status === "passed" ? paths.length : 0,
		failed: status === "failed" ? 1 : 0,
		skipped: 0,
		crash: status === "crash",
		status,
		command,
	};
}

if (import.meta.main) {
	const args = Bun.argv.slice(2);
	const backend = args[args.indexOf("--backend") + 1] as Backend;
	if (backend !== "typescript" && backend !== "rust") throw new Error("--backend must be typescript or rust");
	const value = (flag: string) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : undefined);
	const selected = value("--path");
	console.log(
		JSON.stringify(
			run(resolve("."), backend, {
				worktree: value("--worktree"),
				artifact: value("--artifact"),
				paths: selected ? [selected] : undefined,
			}),
		),
	);
}
