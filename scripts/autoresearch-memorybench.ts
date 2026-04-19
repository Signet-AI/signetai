#!/usr/bin/env bun
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
const canaryFile = join(repoRoot, "memorybench/config/autoresearch/longmemeval-canary-12.txt");
const runRoot = join(repoRoot, "memorybench/data/runs");
const autoresearchRoot = join(repoRoot, ".bench/autoresearch");
const resultsTsv = join(autoresearchRoot, "results/autoresearch.tsv");
const failureQueue = join(autoresearchRoot, "failure-queue.jsonl");

type Command = "status" | "ids" | "triage" | "record" | "compare" | "run-canary" | "help";

interface Metrics {
	accuracy: number;
	correct: number;
	total: number;
	hitAtK: number;
	f1: number;
	mrr: number;
	ndcg: number;
	searchMs: number;
	contextTokens: number;
}

interface Report {
	provider?: string;
	benchmark?: string;
	runId: string;
	judge?: string;
	answeringModel?: string;
	timestamp?: string;
	summary?: {
		totalQuestions?: number;
		correctCount?: number;
		accuracy?: number;
	};
	latency?: { search?: { mean?: number } };
	tokens?: { avgContextTokens?: number };
	retrieval?: { hitAtK?: number; f1AtK?: number; mrr?: number; ndcg?: number };
	evaluations?: Evaluation[];
}

interface Evaluation {
	questionId: string;
	questionType?: string;
	question?: string;
	label?: string;
	score?: number;
	explanation?: string;
	hypothesis?: string;
	groundTruth?: string;
	retrievalMetrics?: {
		hitAtK?: number;
		f1AtK?: number;
		mrr?: number;
		ndcg?: number;
		relevantRetrieved?: number;
		totalRelevant?: number;
	};
}

function usage(): void {
	console.log(`MemoryBench autoresearch helper

Usage:
  bun scripts/autoresearch-memorybench.ts status
  bun scripts/autoresearch-memorybench.ts ids
  bun scripts/autoresearch-memorybench.ts triage --run-id <id> [--write-queue]
  bun scripts/autoresearch-memorybench.ts record --run-id <id> [--note <text>]
  bun scripts/autoresearch-memorybench.ts compare --base <id> --candidate <id>
  bun scripts/autoresearch-memorybench.ts run-canary [--execute] [--skip-ingest] [--ingest-only]

The ratchet is simple: change one thing, run the fixed canary, keep the patch
only if canary metrics improve without known regressions. Random samples feed
the failure queue; they are not the scoreboard.`);
}

function argValue(args: string[], name: string): string | undefined {
	const index = args.indexOf(name);
	return index >= 0 ? args[index + 1] : undefined;
}

function hasFlag(args: string[], name: string): boolean {
	return args.includes(name);
}

function readIds(path = canaryFile): string[] {
	return readFileSync(path, "utf8")
		.split(/\r?\n/)
		.map((line) => line.replace(/#.*/, "").trim())
		.filter((line) => line.length > 0);
}

function readReport(runId: string): Report {
	const path = join(runRoot, runId, "report.json");
	if (!existsSync(path)) throw new Error(`Missing report: ${path}`);
	return JSON.parse(readFileSync(path, "utf8")) as Report;
}

function metrics(report: Report): Metrics {
	const total = report.summary?.totalQuestions ?? report.evaluations?.length ?? 0;
	const correct = report.summary?.correctCount ?? 0;
	return {
		accuracy: report.summary?.accuracy ?? (total > 0 ? correct / total : 0),
		correct,
		total,
		hitAtK: report.retrieval?.hitAtK ?? 0,
		f1: report.retrieval?.f1AtK ?? 0,
		mrr: report.retrieval?.mrr ?? 0,
		ndcg: report.retrieval?.ndcg ?? 0,
		searchMs: report.latency?.search?.mean ?? 0,
		contextTokens: report.tokens?.avgContextTokens ?? 0,
	};
}

function fmtPct(value: number): string {
	return `${(value * 100).toFixed(1)}%`;
}

function fmtMetrics(runId: string, m: Metrics): string {
	return `${runId}: ${m.correct}/${m.total} ${fmtPct(m.accuracy)}, Hit@K ${fmtPct(m.hitAtK)}, F1 ${m.f1.toFixed(3)}, MRR ${m.mrr.toFixed(3)}, NDCG ${m.ndcg.toFixed(3)}, search ${Math.round(m.searchMs)}ms, ctx ${Math.round(m.contextTokens)}tok`;
}

function classify(evalResult: Evaluation): string {
	const correct = evalResult.label === "correct" || (evalResult.score ?? 0) >= 1;
	const retrieval = evalResult.retrievalMetrics;
	const hit = retrieval?.hitAtK ?? 0;
	const mrr = retrieval?.mrr ?? 0;

	if (!correct && hit <= 0) return "retrieval_miss";
	if (!correct && mrr < 0.5) return "ranking_weak";
	if (!correct) return "answer_or_currentness_failure";
	if (hit > 0 && mrr < 1) return "passed_low_rank";
	return "passed";
}

function triage(runId: string, writeQueue: boolean): void {
	const report = readReport(runId);
	const evals = report.evaluations ?? [];
	const buckets = new Map<string, Evaluation[]>();
	for (const item of evals) {
		const key = classify(item);
		buckets.set(key, [...(buckets.get(key) || []), item]);
	}

	console.log(fmtMetrics(runId, metrics(report)));
	for (const key of ["retrieval_miss", "ranking_weak", "answer_or_currentness_failure", "passed_low_rank", "passed"]) {
		const items = buckets.get(key) || [];
		if (items.length === 0) continue;
		console.log(`\n${key} (${items.length})`);
		for (const item of items) {
			const r = item.retrievalMetrics;
			console.log(
				`  ${item.questionId.padEnd(18)} ${(item.questionType || "unknown").padEnd(26)} label=${item.label ?? "?"} mrr=${(r?.mrr ?? 0).toFixed(3)} hit=${(r?.hitAtK ?? 0).toFixed(1)} ndcg=${(r?.ndcg ?? 0).toFixed(3)}`,
			);
			if (key !== "passed") console.log(`    ${item.question || ""}`);
		}
	}

	if (writeQueue) {
		mkdirSync(dirname(failureQueue), { recursive: true });
		const rows = evals
			.map((item) => ({ runId, bucket: classify(item), item }))
			.filter((row) => row.bucket !== "passed")
			.map((row) => JSON.stringify(row));
		if (rows.length > 0) writeFileSync(failureQueue, `${rows.join("\n")}\n`, { flag: "a" });
		console.log(`\nQueued ${rows.length} non-perfect items in ${failureQueue}`);
	}
}

function record(runId: string, note: string): void {
	const report = readReport(runId);
	const m = metrics(report);
	mkdirSync(dirname(resultsTsv), { recursive: true });
	if (!existsSync(resultsTsv)) {
		writeFileSync(
			resultsTsv,
			"timestamp\trun_id\taccuracy\tcorrect\ttotal\thit_at_k\tf1\tmrr\tndcg\tsearch_ms\tcontext_tokens\tnote\n",
		);
	}
	writeFileSync(
		resultsTsv,
		`${new Date().toISOString()}\t${runId}\t${m.accuracy.toFixed(6)}\t${m.correct}\t${m.total}\t${m.hitAtK.toFixed(6)}\t${m.f1.toFixed(6)}\t${m.mrr.toFixed(6)}\t${m.ndcg.toFixed(6)}\t${Math.round(m.searchMs)}\t${Math.round(m.contextTokens)}\t${note.replace(/\s+/g, " ")}\n`,
		{ flag: "a" },
	);
	console.log(`Recorded ${runId} in ${resultsTsv}`);
}

function compare(baseRunId: string, candidateRunId: string): void {
	const base = metrics(readReport(baseRunId));
	const candidate = metrics(readReport(candidateRunId));
	console.log(fmtMetrics(baseRunId, base));
	console.log(fmtMetrics(candidateRunId, candidate));
	console.log("\nDelta candidate - base");
	console.log(`  accuracy: ${fmtPct(candidate.accuracy - base.accuracy)}`);
	console.log(`  Hit@K:    ${fmtPct(candidate.hitAtK - base.hitAtK)}`);
	console.log(`  F1:       ${(candidate.f1 - base.f1).toFixed(3)}`);
	console.log(`  MRR:      ${(candidate.mrr - base.mrr).toFixed(3)}`);
	console.log(`  NDCG:     ${(candidate.ndcg - base.ndcg).toFixed(3)}`);
	console.log(`  search:   ${Math.round(candidate.searchMs - base.searchMs)}ms`);
	console.log(`  context:  ${Math.round(candidate.contextTokens - base.contextTokens)}tok`);

	const regressed =
		candidate.correct < base.correct ||
		candidate.hitAtK < base.hitAtK ||
		candidate.mrr < base.mrr ||
		candidate.ndcg < base.ndcg;
	const improved =
		candidate.correct > base.correct ||
		candidate.hitAtK > base.hitAtK ||
		candidate.mrr > base.mrr ||
		candidate.ndcg > base.ndcg;
	console.log(
		`\nRatchet verdict: ${improved && !regressed ? "keep" : regressed ? "discard or investigate" : "neutral"}`,
	);
}

function latestReports(limit = 8): string[] {
	if (!existsSync(runRoot)) return [];
	return readdirSync(runRoot)
		.map((runId) => ({ runId, path: join(runRoot, runId, "report.json") }))
		.filter((item) => existsSync(item.path))
		.sort((a, b) => statSync(b.path).mtimeMs - statSync(a.path).mtimeMs)
		.slice(0, limit)
		.map((item) => item.runId);
}

function printProcesses(): void {
	const result = spawnSync(
		"pgrep",
		["-af", "bench-memory|memorybench/src/index|packages/daemon/src/daemon|llama-server|vllm"],
		{
			encoding: "utf8",
		},
	);
	const output = result.stdout.trim();
	console.log(output ? output : "No benchmark/model processes found.");
}

function status(): void {
	console.log(`Canary file: ${canaryFile}`);
	console.log(`Canary questions: ${readIds().length}`);
	console.log(`Autoresearch TSV: ${resultsTsv}`);
	console.log("\nProcesses:");
	printProcesses();
	console.log("\nLatest reports:");
	for (const runId of latestReports()) console.log(`  ${fmtMetrics(runId, metrics(readReport(runId)))}`);
	if (existsSync(resultsTsv)) {
		console.log("\nRecent autoresearch rows:");
		for (const line of readFileSync(resultsTsv, "utf8").trim().split(/\r?\n/).slice(-6)) console.log(line);
	}
}

function shellLine(env: Record<string, string>, command: string[]): string {
	const envText = Object.entries(env)
		.map(([key, value]) => `${key}=${JSON.stringify(value)}`)
		.join(" ");
	return `${envText} ${command.map((part) => JSON.stringify(part)).join(" ")}`;
}

function runCommand(command: string[], env: Record<string, string>): void {
	const [bin, ...argv] = command;
	if (!bin) throw new Error("Cannot run an empty command");
	const result = spawnSync(bin, argv, {
		cwd: repoRoot,
		env: { ...process.env, ...env },
		stdio: "inherit",
	});
	if (result.status !== 0) throw new Error(`${command.join(" ")} failed with ${result.status ?? result.signal}`);
}

function runCanary(args: string[]): void {
	const execute = hasFlag(args, "--execute");
	const skipIngest = hasFlag(args, "--skip-ingest");
	const ingestOnly = hasFlag(args, "--ingest-only");
	const runId =
		argValue(args, "--run-id") ||
		`lme-canary12-${new Date()
			.toISOString()
			.replace(/[-:]/g, "")
			.replace(/\.\d+Z$/, "Z")}`;
	const workspace = argValue(args, "--workspace") || join(repoRoot, ".bench/workspaces/lme-canary12");
	const baseUrl = argValue(args, "--base-url") || "http://127.0.0.1:8000/v1";
	const ingestBaseUrl = argValue(args, "--ingest-base-url") || baseUrl;
	const answerBaseUrl = argValue(args, "--answer-base-url") || baseUrl;
	const ingestModel = argValue(args, "--ingest-model") || "google/gemma-4-E4B-it";
	const answerModel = argValue(args, "--answer-model") || "google_gemma-4-26B-A4B-it-Q5_K_M.gguf";
	const judgeModel = argValue(args, "--judge-model") || answerModel;
	const sessionConcurrency = argValue(args, "--session-concurrency") || "8";
	const ingestConcurrency = argValue(args, "--ingest-concurrency") || "3";
	const answerConcurrency = argValue(args, "--answer-concurrency") || "1";
	const evaluateConcurrency = argValue(args, "--evaluate-concurrency") || "1";

	const commonEnv = {
		OPENAI_API_KEY: process.env.OPENAI_API_KEY || "dummy",
		SIGNET_BENCH_RUN_ID: runId,
		SIGNET_BENCH_EMBEDDING_PROVIDER: "ollama",
		SIGNET_BENCH_EMBEDDING_MODEL: "nomic-embed-text",
	};
	const ingestEnv = {
		...commonEnv,
		OPENAI_BASE_URL: ingestBaseUrl,
		MEMORYBENCH_EXTRACTION_MODEL: ingestModel,
		MEMORYBENCH_EXTRACTION_MAX_TOKENS: "1200",
		MEMORYBENCH_STRUCTURED_EXTRACTION_MAX_TOKENS: "1800",
		MEMORYBENCH_SESSION_CONCURRENCY: sessionConcurrency,
	};
	const evalEnv = {
		...commonEnv,
		OPENAI_BASE_URL: answerBaseUrl,
		SIGNET_BENCH_ANSWERING_MODEL: answerModel,
		SIGNET_BENCH_JUDGE: judgeModel,
	};

	const ingest = [
		"bun",
		"run",
		"bench:ingest",
		"--",
		"--no-build",
		"--workspace",
		workspace,
		"--question-ids-file",
		canaryFile,
		"--concurrency-ingest",
		ingestConcurrency,
	];
	const evaluate = [
		"bun",
		"run",
		"bench:evaluate",
		"--",
		"--no-build",
		"--workspace",
		workspace,
		"--concurrency-answer",
		answerConcurrency,
		"--concurrency-evaluate",
		evaluateConcurrency,
	];

	console.log(`Run id: ${runId}`);
	console.log(`Workspace: ${workspace}`);
	console.log(`Canary: ${readIds().length} questions from ${canaryFile}`);
	if (ingestBaseUrl === answerBaseUrl && !skipIngest && !ingestOnly) {
		console.log(
			"Note: ingest and answer phases use the same base URL. If you need to swap vLLM for llama.cpp, run ingestion first, then rerun with --skip-ingest after switching servers.",
		);
	}
	if (!skipIngest) console.log(`\n${shellLine(ingestEnv, ingest)}`);
	if (!ingestOnly) console.log(`\n${shellLine(evalEnv, evaluate)}`);

	if (!execute) {
		console.log(
			"\nDry plan only. Add --execute to run it. Start/stop the local model server between phases if needed.",
		);
		return;
	}

	if (!skipIngest) runCommand(ingest, ingestEnv);
	if (ingestOnly) {
		console.log(`Ingest complete for ${runId}. Switch to the answer/judge server, then run with --skip-ingest.`);
		return;
	}
	runCommand(evaluate, evalEnv);
	record(runId, "canary12 local autoresearch");
	triage(runId, true);
}

function main(): void {
	const [rawCommand = "help", ...args] = process.argv.slice(2);
	const command = rawCommand as Command;

	if (command === "help") {
		usage();
		return;
	}
	if (command === "status") {
		status();
		return;
	}
	if (command === "ids") {
		console.log(readIds().join("\n"));
		return;
	}
	if (command === "run-canary") {
		runCanary(args);
		return;
	}

	const runId = argValue(args, "--run-id");
	if ((command === "triage" || command === "record") && !runId) throw new Error(`${command} requires --run-id`);

	if (command === "triage") {
		if (!runId) throw new Error("triage requires --run-id");
		triage(runId, hasFlag(args, "--write-queue"));
		return;
	}
	if (command === "record") {
		if (!runId) throw new Error("record requires --run-id");
		record(runId, argValue(args, "--note") || "");
		return;
	}
	if (command === "compare") {
		const base = argValue(args, "--base");
		const candidate = argValue(args, "--candidate");
		if (!base || !candidate) throw new Error("compare requires --base and --candidate");
		compare(base, candidate);
		return;
	}

	usage();
}

try {
	main();
} catch (error) {
	console.error(error instanceof Error ? error.message : String(error));
	process.exit(1);
}
