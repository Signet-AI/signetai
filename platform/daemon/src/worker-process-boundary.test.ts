import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

type ProcessLaunch = {
	readonly path: string;
	readonly line: number;
	readonly text: string;
};

type IntentionalProcessOwner = {
	readonly count: number;
	readonly reason: string;
};

const sourceRoot = fileURLToPath(new URL(".", import.meta.url));
const compiledRuntimeLaunch =
	/\b(?:nodeSpawn|spawn(?:Hidden)?)\s*\(\s*(?:(?:runtimePath|preferredExecutablePath)\s*\?\?\s*)?(?:process\.execPath|options\.executable)\b|\bBun\.spawn\s*\(\s*\[\s*process\.execPath\b/g;

const intentionalProcessOwners: Readonly<Record<string, IntentionalProcessOwner>> = {
	"daemon.ts": { count: 1, reason: "daemon replacement after an update" },
	"database-integrity.ts": { count: 1, reason: "killable integrity worker runner" },
	"db-owner-client.ts": { count: 1, reason: "exclusive synchronous SQLite owner" },
	"transcript-recovery-supervisor.ts": { count: 1, reason: "killable transcript recovery supervisor" },
	"transcript-recovery-worker.ts": { count: 1, reason: "bounded transcript recovery child" },
};

const inProcessHelpers = [
	{
		name: "native source scanner",
		path: "native-memory-source-worker.ts",
		required: [/\bnew Worker\s*\(/, /\bparentPort\b/],
	},
	{
		name: "synthesis renderer",
		path: "synthesis-render-worker.ts",
		required: [/\bparentPort\b/],
	},
	{
		name: "native embedding adapter",
		path: "embedding-worker-handle.ts",
		required: [/\bnew Worker\s*\(/, /\bworker\.terminate\s*\(/],
	},
	{
		name: "pipeline helpers",
		path: "pipeline/index.ts",
		required: [/\bstartDocumentWorker\b/, /\bstartSynthesisWorker\b/],
	},
] as const;

function sourceFiles(directory: string): string[] {
	return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
		const path = join(directory, entry.name);
		if (entry.isDirectory()) return sourceFiles(path);
		if (!entry.isFile() || !entry.name.endsWith(".ts") || entry.name.endsWith(".test.ts")) return [];
		return [path];
	});
}

function relativeSourcePath(path: string): string {
	return relative(sourceRoot, path).replaceAll("\\", "/");
}

function findCompiledRuntimeLaunches(): ProcessLaunch[] {
	const launches: ProcessLaunch[] = [];
	for (const path of sourceFiles(sourceRoot)) {
		const source = readFileSync(path, "utf8");
		const pattern = new RegExp(compiledRuntimeLaunch.source, "g");
		for (const match of source.matchAll(pattern)) {
			const offset = match.index ?? 0;
			const line = source.slice(0, offset).split("\n").length;
			launches.push({
				path: relativeSourcePath(path),
				line,
				text: source
					.slice(offset, source.indexOf("\n", offset) === -1 ? source.length : source.indexOf("\n", offset))
					.trim(),
			});
		}
	}
	return launches;
}

describe("worker/process boundaries", () => {
	it("keeps migrated helpers in the daemon runtime", () => {
		const violations: string[] = [];
		for (const helper of inProcessHelpers) {
			const path = join(sourceRoot, helper.path);
			const source = readFileSync(path, "utf8");
			for (const required of helper.required) {
				if (!required.test(source)) violations.push(`${helper.name} is missing ${required}`);
			}
			if (compiledRuntimeLaunch.test(source)) {
				violations.push(`${helper.name} contains a compiled-runtime launch`);
			}
			compiledRuntimeLaunch.lastIndex = 0;
		}
		if (violations.length > 0) throw new Error(violations.join("\n"));
	});

	it("audits compiled-runtime launches and reports intentional owners", () => {
		const launches = findCompiledRuntimeLaunches();
		const counts = new Map<string, number>();
		for (const launch of launches) counts.set(launch.path, (counts.get(launch.path) ?? 0) + 1);

		const report = [
			"worker/process boundary audit",
			`in-process helpers: ${inProcessHelpers.map((helper) => helper.name).join(", ")}`,
			"intentional compiled-runtime process owners:",
			...launches.map((launch) => {
				const owner = intentionalProcessOwners[launch.path];
				return `  - ${launch.path}:${launch.line} — ${owner?.reason ?? "UNACCOUNTED"} (${launch.text})`;
			}),
		].join("\n");
		console.info(report);

		const violations = launches
			.filter((launch) => intentionalProcessOwners[launch.path] === undefined)
			.map((launch) => `${launch.path}:${launch.line}`);
		for (const [path, owner] of Object.entries(intentionalProcessOwners)) {
			if ((counts.get(path) ?? 0) !== owner.count) {
				violations.push(`${path}: expected ${owner.count} launch site(s), found ${counts.get(path) ?? 0}`);
			}
		}

		expect(violations, report).toEqual([]);
	});
});
