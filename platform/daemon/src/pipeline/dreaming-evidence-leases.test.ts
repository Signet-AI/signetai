import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import type { DreamingConfig } from "@signet/core";
import { runMigrations } from "../../../core/src/migrations";
import type { DbAccessor } from "../db-accessor";
import { createDreamingAgentTools } from "./dreaming-agent-tools";
import { type DreamingAgentExecutor, getDreamingToolCalls, runDreamingAgentPass } from "./dreaming";
import { leaseDreamingEvidence } from "./dreaming-evidence-leases";

const AGENT = "default";

function cfg(): DreamingConfig {
	return {
		enabled: true,
		tokenThreshold: 100_000,
		maxInterval: 6 * 60 * 60 * 1_000,
		maxInputTokens: 32_000,
		maxOutputTokens: 16_000,
		maxConcurrentPasses: 2,
		codemode: false,
		timeout: 300_000,
		backfillOnFirstRun: false,
	};
}

function wrapDb(db: Database): DbAccessor {
	const tx = <T>(fn: (db: Database) => T): T => {
		db.exec("BEGIN IMMEDIATE");
		try {
			const result = fn(db);
			db.exec("COMMIT");
			return result;
		} catch (e) {
			db.exec("ROLLBACK");
			throw e;
		}
	};
	return {
		withReadDb: <T>(fn: (db: Database) => T): T => fn(db),
		withReadDbAsync: <T>(fn: (db: Database) => Promise<T>): Promise<T> => fn(db),
		withWriteTx: tx,
		withWriteTxAsync: <T>(fn: (db: Database) => T): Promise<T> => Promise.resolve().then(() => tx(fn)),
	} as unknown as DbAccessor;
}

type Tool = ReturnType<typeof createDreamingAgentTools>[number];

function result(res: { content: ReadonlyArray<unknown> }): Record<string, unknown> {
	const first = res.content[0] as { text?: string } | undefined;
	return JSON.parse(first?.text ?? "{}") as Record<string, unknown>;
}

function refsOf(output: Record<string, unknown>): string[] {
	return ((output.items as Array<{ sourceRef: string }> | undefined) ?? []).map((item) => item.sourceRef);
}

function tool(tools: readonly Tool[], name: string): Tool {
	const found = tools.find((candidate) => candidate.name === name);
	if (!found) throw new Error(`Missing ${name}`);
	return found;
}

async function readAndReview(tools: readonly Tool[], input: Record<string, unknown>): Promise<void> {
	const output = result(await tool(tools, "search_evidence").execute("read", input, undefined, undefined, {} as never));
	const items = ((output.items as Array<{ sourceRef: string; contentOffset: number }> | undefined) ?? []).map(
		(item) => ({ sourceRef: item.sourceRef, contentOffset: item.contentOffset }),
	);
	if (items.length === 0) return;
	const reviewed = result(
		await tool(tools, "review_evidence").execute(
			"review",
			{ agentId: AGENT, items },
			undefined,
			undefined,
			{} as never,
		),
	);
	if (reviewed.ok !== true) throw new Error(`review_evidence failed: ${JSON.stringify(reviewed)}`);
}

describe("Dreaming evidence leases", () => {
	let db: Database;
	let accessor: DbAccessor;

	beforeEach(() => {
		db = new Database(":memory:");
		runMigrations(db as unknown as Parameters<typeof runMigrations>[0]);
		accessor = wrapDb(db);
	});

	afterEach(() => {
		db.close();
	});

	function seedTranscripts(count: number): string[] {
		const insert = db.prepare(
			`INSERT INTO session_transcripts
			 (session_key, agent_id, content, harness, created_at, updated_at, completed_at)
			 VALUES (?, ?, ?, 'pi', ?, ?, ?)`,
		);
		return Array.from({ length: count }, (_, index) => {
			const key = `session-${String(index).padStart(2, "0")}`;
			const at = new Date(Date.UTC(2026, 0, 1, index)).toISOString();
			insert.run(key, AGENT, `User: Session ${index} says the user lives in city ${index}.`, at, at, at);
			return `transcript:${key}`;
		});
	}

	function startPassRow(passId: string): void {
		db.prepare(
			`INSERT INTO dreaming_passes (id, agent_id, mode, status, started_at, created_at)
			 VALUES (?, ?, 'incremental', 'running', datetime('now'), datetime('now'))`,
		).run(passId, AGENT);
	}

	async function drain(passId: string, limit: number): Promise<Record<string, unknown>> {
		const tools = createDreamingAgentTools({
			accessor,
			agentId: AGENT,
			allowedAgentIds: [AGENT],
			actor: "dreaming",
			passId,
			evidenceLeaseMs: 60_000,
		});
		return result(
			await tool(tools, "search_evidence").execute(
				"call",
				{ agentId: AGENT, limit },
				undefined,
				undefined,
				{} as never,
			),
		);
	}

	it("hands concurrent passes in one scope disjoint evidence", async () => {
		const all = seedTranscripts(6);
		startPassRow("pass-a");
		startPassRow("pass-b");

		const first = await drain("pass-a", 3);
		const second = await drain("pass-b", 3);
		const a = refsOf(first);
		const b = refsOf(second);

		expect(a).toHaveLength(3);
		expect(b).toHaveLength(3);
		expect(a.filter((ref) => b.includes(ref))).toEqual([]);
		expect([...a, ...b].sort()).toEqual([...all].sort());
		expect(refsOf(await drain("pass-a", 6)).sort()).toEqual([...a].sort());
		expect(refsOf(await drain("pass-c", 6))).toEqual([]);
	});

	it("gives a contested source to exactly one pass", async () => {
		const refs = seedTranscripts(4);
		startPassRow("pass-a");
		startPassRow("pass-b");

		const [a, b] = await Promise.all([
			leaseDreamingEvidence(accessor, { agentId: AGENT, passId: "pass-a", sourceRefs: refs, ttlMs: 60_000 }),
			leaseDreamingEvidence(accessor, { agentId: AGENT, passId: "pass-b", sourceRefs: refs, ttlMs: 60_000 }),
		]);

		for (const ref of refs) expect(Number(a.has(ref)) + Number(b.has(ref))).toBe(1);
		expect(
			await leaseDreamingEvidence(accessor, { agentId: AGENT, passId: "pass-a", sourceRefs: refs, ttlMs: 60_000 }),
		).toEqual(a);
	});

	async function drainWhileRacing(raced: readonly string[], limit: number): Promise<Record<string, unknown>> {
		const tools = createDreamingAgentTools({
			accessor,
			agentId: AGENT,
			allowedAgentIds: [AGENT],
			actor: "dreaming",
			passId: "pass-b",
			evidenceLeaseMs: 60_000,
		});
		const prepare = db.prepare.bind(db);
		let raceRun = false;
		(db as unknown as { prepare: Database["prepare"] }).prepare = ((sql: string) => {
			if (!raceRun && sql.includes("INSERT INTO dreaming_evidence_leases")) {
				raceRun = true;
				for (const ref of raced) {
					prepare(
						`INSERT INTO dreaming_evidence_leases (agent_id, source_kind, source_id, pass_id, leased_at, expires_at)
						 VALUES (?, 'transcript', ?, 'pass-a', datetime('now'), datetime('now', '+1 hour'))`,
					).run(AGENT, ref.slice("transcript:".length));
				}
			}
			return prepare(sql);
		}) as Database["prepare"];
		try {
			return result(
				await tool(tools, "search_evidence").execute(
					"call",
					{ agentId: AGENT, limit },
					undefined,
					undefined,
					{} as never,
				),
			);
		} finally {
			Reflect.deleteProperty(db, "prepare");
			expect(raceRun).toBe(true);
		}
	}

	it("fills a page with unclaimed sources when another pass wins a lease race", async () => {
		const refs = seedTranscripts(4);
		startPassRow("pass-a");
		startPassRow("pass-b");
		const raced = refs.slice(-1);

		const output = await drainWhileRacing(raced, 3);

		expect(refsOf(output)).toHaveLength(3);
		expect(refsOf(output).sort()).toEqual(refs.filter((ref) => !raced.includes(ref)).sort());
		expect(output.hasMore).toBe(false);
		expect(output.heldByOtherPasses).toBeUndefined();
		expect(
			db.prepare("SELECT pass_id AS passId, COUNT(*) AS n FROM dreaming_evidence_leases GROUP BY pass_id").all(),
		).toEqual([
			{ passId: "pass-a", n: 1 },
			{ passId: "pass-b", n: 3 },
		]);
	});

	it("ends the queue for a pass when other passes hold everything left", async () => {
		const refs = seedTranscripts(2);
		startPassRow("pass-a");
		startPassRow("pass-b");

		const output = await drainWhileRacing(refs, 2);

		expect(refsOf(output)).toEqual([]);
		expect(output.hasMore).toBe(false);
		expect(output.heldByOtherPasses).toBe(true);
		expect(String(output.note)).toContain("other running Dreaming passes");
		expect(await drain("pass-c", 5)).toMatchObject({ items: [], hasMore: false, heldByOtherPasses: true });
	});

	it("redelivers the evidence of a pass that failed or whose lease expired", async () => {
		seedTranscripts(4);
		startPassRow("pass-a");
		startPassRow("pass-b");
		startPassRow("pass-c");
		const failed = refsOf(await drain("pass-a", 2));
		const expiring = refsOf(await drain("pass-b", 4));
		expect(failed).toHaveLength(2);
		expect(expiring.some((ref) => failed.includes(ref))).toBe(false);

		db.prepare("UPDATE dreaming_passes SET status = 'failed' WHERE id = 'pass-a'").run();
		expect(refsOf(await drain("pass-c", 4)).sort()).toEqual([...failed].sort());

		db.prepare(
			"UPDATE dreaming_evidence_leases SET expires_at = datetime('now', '-1 minute') WHERE pass_id = 'pass-b'",
		).run();
		startPassRow("pass-d");
		expect(refsOf(await drain("pass-d", 4)).sort()).toEqual([...expiring].sort());
	});

	it("does not settle a source another running pass holds", async () => {
		const [held, ...rest] = seedTranscripts(3);
		if (held === undefined) throw new Error("missing seed");
		startPassRow("holder");
		await leaseDreamingEvidence(accessor, { agentId: AGENT, passId: "holder", sourceRefs: [held], ttlMs: 60_000 });

		const executor: DreamingAgentExecutor = {
			async run(input) {
				const tools = input.tools as readonly Tool[];
				await readAndReview(tools, { agentId: AGENT, sourceRef: held, chunkSize: 4_000 });
				await readAndReview(tools, { agentId: AGENT });
				return { summary: "Read the queue." };
			},
		};
		const pass = await runDreamingAgentPass(
			accessor,
			executor,
			cfg(),
			"/tmp",
			AGENT,
			[AGENT],
			"incremental",
			undefined,
			undefined,
			{
				sharedScope: { evidenceLeaseMs: 60_000, attentionScopes: [AGENT] },
			},
		);

		const settled = db
			.prepare(
				`SELECT source_id AS id FROM dreaming_evidence_consumption
				 WHERE agent_id = ? AND delivered_offset >= source_length ORDER BY source_id`,
			)
			.all(AGENT) as Array<{ id: string }>;
		expect(settled.map((row) => `transcript:${row.id}`)).toEqual(rest);
		expect(db.prepare("SELECT pass_id AS passId FROM dreaming_evidence_leases").all()).toEqual([{ passId: "holder" }]);

		db.prepare("UPDATE dreaming_passes SET status = 'failed' WHERE id = 'holder'").run();
		startPassRow("next");
		expect(refsOf(await drain("next", 5))).toEqual([held]);
		expect(pass.passId).toBeString();
	});

	it("drains one scope with concurrent passes that each settle only their own evidence", async () => {
		const all = seedTranscripts(8);
		db.prepare(
			`INSERT INTO dreaming_attention (id, agent_id, kind, subject_ref, details_json, priority)
			 VALUES ('contested', ?, 'contested_claim', 'memory:claim', '{}', 90)`,
		).run(AGENT);
		let release: () => void = () => undefined;
		const barrier = new Promise<void>((resolve) => {
			release = resolve;
		});
		let reading = 0;
		const prompts = new Map<string, string>();
		const executor = (name: string): DreamingAgentExecutor => ({
			async run(input) {
				prompts.set(name, input.prompt);
				await readAndReview(input.tools as readonly Tool[], { agentId: AGENT, limit: 4 });
				reading++;
				await barrier;
				return { summary: `${name} read its page.` };
			},
		});
		const run = (name: string, attentionScopes: readonly string[]) =>
			runDreamingAgentPass(
				accessor,
				executor(name),
				cfg(),
				"/tmp",
				AGENT,
				[AGENT],
				"incremental",
				undefined,
				undefined,
				{
					sharedScope: { evidenceLeaseMs: 60_000, attentionScopes },
				},
			);

		const first = run("first", [AGENT]);
		const second = run("second", []);
		const deadline = Date.now() + 5_000;
		while (reading < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10));
		expect(reading).toBe(2);
		release();
		const [a, b] = await Promise.all([first, second]);

		const delivered = async (passId: string) =>
			(await getDreamingToolCalls(accessor, AGENT, passId))
				.filter((call) => call.toolName === "search_evidence")
				.flatMap((call) => refsOf(call.output as Record<string, unknown>));
		const aRefs = await delivered(a.passId);
		const bRefs = await delivered(b.passId);
		expect(aRefs).toHaveLength(4);
		expect(bRefs).toHaveLength(4);
		expect(aRefs.filter((ref) => bRefs.includes(ref))).toEqual([]);
		const settled = db
			.prepare(
				`SELECT source_id AS id, pass_id AS passId FROM dreaming_evidence_consumption
				 WHERE agent_id = ? AND delivered_offset >= source_length`,
			)
			.all(AGENT) as Array<{ id: string; passId: string }>;
		expect(settled.map((row) => `transcript:${row.id}`).sort()).toEqual([...all].sort());
		for (const row of settled) {
			expect(row.passId).toBe(aRefs.includes(`transcript:${row.id}`) ? a.passId : b.passId);
		}
		expect(db.prepare("SELECT COUNT(*) AS n FROM dreaming_evidence_leases").get()).toEqual({ n: 0 });
		const pending = (name: string) => {
			const prompt = prompts.get(name) ?? "";
			return prompt.slice(prompt.lastIndexOf("<pending_attention>"), prompt.lastIndexOf("</pending_attention>"));
		};
		expect(pending("first")).toContain('"kind":"contested_claim"');
		expect(pending("second")).toContain("none pending");
		expect(pending("second")).not.toContain("contested_claim");
	});
});
