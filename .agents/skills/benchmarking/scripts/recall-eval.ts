import { spawn } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import net from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { type Checkpoint, argValue, readCheckpoint, repoRoot } from "./lib";

const USAGE = `Usage: bun .agents/skills/benchmarking/scripts/recall-eval.ts --run <runId> --workspace <benchWorkspace> [--limit 10] [--threshold 0.3]

Copies a finished bench workspace, starts a daemon on the copy with Dreaming disabled, and replays each
question of the run through /api/memory/recall with the harness's own query builder. For LongMemEval it
reports the rank of the first result from a gold session and of the first result containing a short
ground-truth answer. The original workspace is never modified.`;

interface RecallResult {
	readonly session_id?: string;
	readonly content?: string;
}

interface Row {
	readonly questionId: string;
	readonly results: number;
	readonly goldSessionRank: number | null;
	readonly answerRank: number | null;
}

function freePort(): Promise<number> {
	return new Promise((resolvePort, reject) => {
		const server = net.createServer();
		server.unref();
		server.on("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			const port = typeof address === "object" && address ? address.port : 0;
			server.close(() => resolvePort(port));
		});
	});
}

function goldSessions(benchmark: string, questionId: string): Set<string> | null {
	if (benchmark !== "longmemeval") return null;
	const path = join(repoRoot, "memorybench/data/benchmarks/longmemeval/datasets/questions", `${questionId}.json`);
	if (!existsSync(path)) return null;
	const item = JSON.parse(readFileSync(path, "utf8")) as {
		answer_session_ids?: string[];
		haystack_session_ids?: string[];
		haystack_sessions: Array<Array<{ has_answer?: boolean }>>;
	};
	const answerIds = new Set(item.answer_session_ids ?? []);
	const gold = new Set<string>();
	item.haystack_sessions.forEach((session, index) => {
		const id = item.haystack_session_ids?.[index];
		if ((id !== undefined && answerIds.has(id)) || session.some((message) => message.has_answer)) {
			gold.add(`${questionId}-session-${index}`);
		}
	});
	return gold;
}

function shortAnswer(groundTruth: unknown): string | null {
	if (typeof groundTruth !== "string" && typeof groundTruth !== "number") return null;
	const text = String(groundTruth).trim().toLowerCase();
	return text.length > 0 && text.length <= 40 ? text : null;
}

async function waitForHealth(base: string, deadlineMs: number): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	for (;;) {
		try {
			const response = await fetch(`${base}/health`);
			if (response.ok) return;
		} catch {}
		if (Date.now() > deadline) throw new Error(`Daemon at ${base} did not become healthy`);
		await new Promise((r) => setTimeout(r, 1_000));
	}
}

async function evaluate(checkpoint: Checkpoint, base: string, limit: number, threshold: number): Promise<Row[]> {
	const { buildSignetRecallQuery } = await import(join(repoRoot, "memorybench/src/providers/signet/index.ts"));
	const rows: Row[] = [];
	for (const question of Object.values(checkpoint.questions)) {
		const response = await fetch(`${base}/api/memory/recall`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({
				query: buildSignetRecallQuery(question.question, question.questionDate),
				limit,
				threshold,
				agentId: `memorybench-${question.containerTag}`,
				expand: true,
			}),
		});
		if (!response.ok) throw new Error(`Recall failed for ${question.questionId}: HTTP ${response.status}`);
		const results = ((await response.json()) as { results?: RecallResult[] }).results ?? [];
		const gold = goldSessions(checkpoint.benchmark, question.questionId);
		const answer = shortAnswer(question.groundTruth);
		rows.push({
			questionId: question.questionId,
			results: results.length,
			goldSessionRank:
				gold === null ? null : results.findIndex((r) => r.session_id !== undefined && gold.has(r.session_id)) + 1,
			answerRank:
				answer === null ? null : results.findIndex((r) => (r.content ?? "").toLowerCase().includes(answer)) + 1,
		});
	}
	return rows;
}

async function main(): Promise<void> {
	const args = process.argv.slice(2);
	const runId = argValue(args, "--run");
	const workspaceArg = argValue(args, "--workspace");
	if (!runId || !workspaceArg || args.includes("--help")) {
		console.log(USAGE);
		process.exit(runId && workspaceArg ? 0 : 1);
	}
	const workspace = resolve(workspaceArg);
	if (!existsSync(join(workspace, "agents", "agent.yaml"))) {
		throw new Error(`${workspace} is not a bench workspace (expected agents/agent.yaml)`);
	}
	const limit = Number(argValue(args, "--limit") ?? 10);
	const threshold = Number(argValue(args, "--threshold") ?? 0.3);
	const checkpoint = readCheckpoint(runId);

	const copy = await mkdtemp(join(tmpdir(), "signet-recall-eval-"));
	cpSync(join(workspace, "agents"), join(copy, "agents"), { recursive: true });
	if (existsSync(join(workspace, "home"))) cpSync(join(workspace, "home"), join(copy, "home"), { recursive: true });
	else mkdirSync(join(copy, "home"));
	const yamlPath = join(copy, "agents", "agent.yaml");
	const config = parseYaml(readFileSync(yamlPath, "utf8")) as Record<string, unknown>;
	const memory = (config.memory ?? {}) as Record<string, unknown>;
	config.memory = { ...memory, dreaming: { ...((memory.dreaming ?? {}) as Record<string, unknown>), enabled: false } };
	writeFileSync(yamlPath, stringifyYaml(config));

	const port = await freePort();
	const daemon = spawn("bun", ["platform/daemon/src/daemon.ts"], {
		cwd: repoRoot,
		env: {
			...process.env,
			HOME: join(copy, "home"),
			SIGNET_PATH: join(copy, "agents"),
			SIGNET_PORT: String(port),
			SIGNET_HOST: "127.0.0.1",
			SIGNET_BIND: "127.0.0.1",
		},
		stdio: ["ignore", "ignore", "ignore"],
	});
	try {
		const base = `http://127.0.0.1:${port}`;
		await waitForHealth(base, 180_000);
		const rows = await evaluate(checkpoint, base, limit, threshold);
		const ranked = rows.filter((row) => row.goldSessionRank !== null);
		const hits = ranked.filter((row) => (row.goldSessionRank ?? 0) > 0).length;
		const mrr =
			ranked.length === 0
				? null
				: ranked.reduce((sum, row) => sum + ((row.goldSessionRank ?? 0) > 0 ? 1 / (row.goldSessionRank ?? 1) : 0), 0) /
					ranked.length;
		console.log("| question | results | gold session rank | answer rank |");
		console.log("| --- | ---: | ---: | ---: |");
		for (const row of rows) {
			console.log(
				`| ${row.questionId} | ${row.results} | ${row.goldSessionRank ?? "n/a"} | ${row.answerRank ?? "n/a"} |`,
			);
		}
		console.log(
			`\nHit: ${ranked.length === 0 ? "n/a" : `${hits}/${ranked.length}`}  MRR: ${mrr === null ? "n/a" : mrr.toFixed(3)}  (rank 0 = not in the top ${limit})`,
		);
		console.log(JSON.stringify({ runId, limit, hits, mrr, rows }));
	} finally {
		if (daemon.exitCode === null) {
			daemon.kill("SIGTERM");
			await new Promise((r) => daemon.once("exit", r));
		}
		await rm(copy, { recursive: true, force: true });
	}
}

await main();
