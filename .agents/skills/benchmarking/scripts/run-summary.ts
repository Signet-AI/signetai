import { execFileSync } from "node:child_process";
import { appendFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import {
	argValue,
	ledgerPath,
	openReadOnly,
	placeholders,
	readCheckpoint,
	readDreamingSetup,
	readJson,
	repoRoot,
	runsDir,
	scopeAgentIds,
} from "./lib";

const USAGE = `Usage: bun .agents/skills/benchmarking/scripts/run-summary.ts <runId>[=<benchWorkspace>] ... [--append --note "<what changed>"] [--commit <sha>|unknown]

Prints score, retrieval, Dreaming usage, wall time, and (when a workspace is given) the Dreaming setup
and the entities and active claims filed in the run's scopes. --append records each run as one line in
the skill's results ledger, tagged with the checked-out commit and whether the tree was dirty, so append right
after a run finishes and before changing code. --commit overrides that for backfilling older runs.`;

interface Report {
	readonly summary: { totalQuestions: number; correctCount: number };
	readonly retrieval?: { hitAtK?: number; mrr?: number; k?: number };
	readonly usage?: {
		dreaming?: {
			passesObserved?: number;
			passesWithoutUsage?: number;
			inputTokens?: number;
			outputTokens?: number;
			cacheReadTokens?: number;
		};
	};
	readonly judge: string;
	readonly answeringModel: string;
	readonly benchmark: string;
	readonly provider: string;
}

interface Summary {
	readonly date: string;
	readonly runId: string;
	readonly commit: string | null;
	readonly dirty: boolean | null;
	readonly benchmark: string;
	readonly provider: string;
	readonly questions: number;
	readonly correct: number;
	readonly hitAtK: number | null;
	readonly mrr: number | null;
	readonly k: number | null;
	readonly answeringModel: string;
	readonly judge: string;
	readonly dreamingExecutor: string | null;
	readonly dreamingModel: string | null;
	readonly codemode: boolean | null;
	readonly maxConcurrentPasses: number | null;
	readonly dreamingPasses: number | null;
	readonly dreamingInputTokens: number | null;
	readonly dreamingOutputTokens: number | null;
	readonly dreamingCacheReadTokens: number | null;
	readonly dreamingPassesWithoutUsage: number | null;
	readonly entities: number | null;
	readonly claims: number | null;
	readonly wallMinutes: number;
	readonly note?: string;
}

function git(args: string[]): string | null {
	try {
		return execFileSync("git", args, { cwd: repoRoot, encoding: "utf8" }).trim();
	} catch {
		return null;
	}
}

function summarize(spec: string, note: string | undefined, commitOverride: string | undefined): Summary {
	const [runId, workspaceArg] = spec.split("=");
	const checkpoint = readCheckpoint(runId);
	const reportPath = join(runsDir, runId, "report.json");
	if (!existsSync(reportPath)) throw new Error(`Run ${runId} has no report.json; it has not finished`);
	const report = readJson<Report>(reportPath);
	const workspace = workspaceArg ? resolve(workspaceArg) : null;
	const setup = workspace
		? readDreamingSetup(workspace)
		: { executor: null, model: null, codemode: null, maxConcurrentPasses: null };
	let entities: number | null = null;
	let claims: number | null = null;
	if (workspace) {
		const scopes = scopeAgentIds(checkpoint);
		const db = openReadOnly(workspace);
		try {
			entities = (
				db
					.query(
						`SELECT COUNT(*) AS c FROM entities WHERE agent_id IN (${placeholders(scopes.length)}) AND COALESCE(status, 'active') = 'active'`,
					)
					.get(...scopes) as { c: number }
			).c;
			claims = (
				db
					.query(
						`SELECT COUNT(*) AS c FROM entity_attributes WHERE agent_id IN (${placeholders(scopes.length)}) AND status = 'active'`,
					)
					.get(...scopes) as { c: number }
			).c;
		} finally {
			db.close();
		}
	}
	const status = commitOverride === undefined ? git(["status", "--porcelain"]) : null;
	const commit =
		commitOverride === undefined
			? git(["rev-parse", "--short", "HEAD"])
			: commitOverride === "unknown"
				? null
				: commitOverride;
	return {
		date: checkpoint.createdAt,
		runId,
		commit,
		dirty: status === null ? null : status.length > 0,
		benchmark: report.benchmark,
		provider: report.provider,
		questions: report.summary.totalQuestions,
		correct: report.summary.correctCount,
		hitAtK: report.retrieval?.hitAtK ?? null,
		mrr: report.retrieval?.mrr ?? null,
		k: report.retrieval?.k ?? null,
		answeringModel: report.answeringModel,
		judge: report.judge,
		dreamingExecutor: setup.executor,
		dreamingModel: setup.model,
		codemode: setup.codemode,
		maxConcurrentPasses: setup.maxConcurrentPasses,
		dreamingPasses: report.usage?.dreaming?.passesObserved ?? null,
		dreamingInputTokens: report.usage?.dreaming?.inputTokens ?? null,
		dreamingOutputTokens: report.usage?.dreaming?.outputTokens ?? null,
		dreamingCacheReadTokens: report.usage?.dreaming?.cacheReadTokens ?? null,
		dreamingPassesWithoutUsage: report.usage?.dreaming?.passesWithoutUsage ?? null,
		entities,
		claims,
		wallMinutes: Math.round((Date.parse(checkpoint.updatedAt) - Date.parse(checkpoint.createdAt)) / 60_000),
		...(note ? { note } : {}),
	};
}

function fmt(value: number | null | undefined, digits = 0): string {
	if (value === null || value === undefined) return "n/a";
	return digits > 0 ? value.toFixed(digits) : String(value);
}

function millions(value: number | null): string {
	return value === null ? "n/a" : `${(value / 1_000_000).toFixed(2)}M`;
}

function main(): void {
	const args = process.argv.slice(2);
	const note = argValue(args, "--note");
	const commitOverride = argValue(args, "--commit");
	const append = args.includes("--append");
	const specs = args.filter(
		(arg, index) => !arg.startsWith("--") && args[index - 1] !== "--note" && args[index - 1] !== "--commit",
	);
	if (specs.length === 0 || args.includes("--help")) {
		console.log(USAGE);
		process.exit(specs.length === 0 ? 1 : 0);
	}
	if (append && !note) throw new Error("--append requires --note describing what the run tested");
	const summaries = specs.map((spec) => summarize(spec, note, commitOverride));
	console.log(
		"| run | dreaming model | codemode | score | Hit@K | MRR | entities | claims | passes | dreaming in/out/cached | wall |",
	);
	console.log("| --- | --- | --- | ---: | ---: | ---: | ---: | ---: | ---: | ---: | ---: |");
	for (const s of summaries) {
		console.log(
			`| ${s.runId} | ${s.dreamingModel ?? "n/a"} | ${s.codemode ?? "n/a"} | ${s.correct}/${s.questions} | ${fmt(s.hitAtK, 2)} | ${fmt(s.mrr, 3)} | ${fmt(s.entities)} | ${fmt(s.claims)} | ${fmt(s.dreamingPasses)} | ${millions(s.dreamingInputTokens)} / ${millions(s.dreamingOutputTokens)} / ${millions(s.dreamingCacheReadTokens)} | ${s.wallMinutes} min |`,
		);
	}
	if (append) {
		mkdirSync(dirname(ledgerPath), { recursive: true });
		for (const s of summaries) appendFileSync(ledgerPath, `${JSON.stringify(s)}\n`);
		console.log(`\nAppended ${summaries.length} run(s) to ${ledgerPath}`);
	}
}

main();
