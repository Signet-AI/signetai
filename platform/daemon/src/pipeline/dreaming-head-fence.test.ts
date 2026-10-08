import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "../db-accessor";
import type { DbOwnerDreamingPassFinalize } from "../db-owner-protocol";
import { commitCuratedMemoryHeadInDb, executeMemoryHead } from "../memory-head-owner";
import type { MemoryHeadCommitInput, MemoryHeadCommitter } from "../memory-head";
import { finalizeDreamingPassInDb } from "./dreaming";
import { getDreamingCapability } from "./dreaming-capabilities";

const quote = "Acme moved to edge runtime in Q2.";

describe("content pass memory-head fence", () => {
	let dir = "";

	beforeEach(() => {
		dir = mkdtempSync(join(tmpdir(), "signet-head-fence-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		initDbAccessor(join(dir, "memory", "memories.db"));
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO entities
				 (id, name, canonical_name, entity_type, agent_id, mentions, pinned, created_at, updated_at)
				 VALUES ('e-acme', 'Acme', 'acme', 'project', 'agent-a', 1, 0, datetime('now'), datetime('now'))`,
			).run();
			db.prepare(
				`INSERT INTO entity_aspects
				 (id, entity_id, agent_id, name, canonical_name, weight, created_at, updated_at)
				 VALUES ('a-main', 'e-acme', 'agent-a', 'general', 'general', 0.5, datetime('now'), datetime('now'))`,
			).run();
			db.prepare(
				`INSERT INTO memories
				 (id, content, source_type, memory_kind, visibility, agent_id, created_at, updated_at)
				 VALUES ('mem-1', ?, 'manual', 'episodic', 'normal', 'agent-a', datetime('now'), datetime('now'))`,
			).run(quote);
			db.prepare(
				`INSERT INTO memories
				 (id, content, source_type, memory_kind, visibility, agent_id, created_at, updated_at)
				 VALUES ('mem-2', 'Acme ships weekly.', 'manual', 'episodic', 'normal', 'agent-a', datetime('now'), datetime('now'))`,
			).run();
		});
	});

	afterEach(async () => {
		await closeDbAccessor();
		rmSync(dir, { recursive: true, force: true });
	});

	function start(passId: string): void {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				"INSERT INTO dreaming_passes (id, agent_id, mode, status) VALUES (?, 'agent-a', 'incremental-content', 'running')",
			).run(passId);
		});
	}

	function head(): { revision: number; isCurrent: number; content: string } {
		return getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare("SELECT revision, is_current AS isCurrent, content FROM memory_md_heads WHERE agent_id = 'agent-a'")
					.get() as { revision: number; isCurrent: number; content: string },
		);
	}

	function input(passId: string, entries: MemoryHeadCommitInput["entries"]): MemoryHeadCommitInput {
		return { agentId: "agent-a", passId, entries };
	}

	const acme = { entryId: "acme", text: quote, support: [{ source_ref: "memory:mem-1", quote }] };

	const committer: MemoryHeadCommitter = {
		read: async () => ({}),
		commit: async () => ({ ok: false }),
	};

	async function supersede(passId: string, inProcess = true): Promise<void> {
		const capability = getDreamingCapability(
			{
				accessor: getDbAccessor(),
				agentId: "agent-a",
				actor: "dreaming",
				passId,
				...(inProcess ? { memoryHeadCommitter: committer } : {}),
			},
			"apply_ontology_ops",
		);
		const evidence = [{ source_ref: "memory:mem-1", source_kind: "manual", source_id: "mem-1", quote }];
		for (const [operation, value] of [
			["add_claim_value", "edge runtime"],
			["supersede_claim_value", "edge runtime in Q2"],
		] as const) {
			const result = await capability?.invoke({
				agentId: "agent-a",
				operations: [
					{ operation, payload: { entityId: "e-acme", aspectId: "a-main", claimKey: "runtime", value }, evidence },
				],
			});
			expect(result).toMatchObject({ ok: true, items: [{ ok: true }] });
		}
	}

	it("publishes over invalidations the running pass caused itself", async () => {
		start("pass-own");
		await supersede("pass-own");
		expect(head().revision).toBeGreaterThan(0);

		const result = getDbAccessor().withWriteTx((db) => commitCuratedMemoryHeadInDb(db, input("pass-own", [acme])));

		expect(result).toMatchObject({ ok: true, code: "COMMITTED" });
		expect(head()).toMatchObject({ isCurrent: 1, content: `- ${quote}` });
	});

	it("still fences a pass when a correction lands outside it", async () => {
		start("pass-ext");
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE memories SET content = 'Acme ships daily.' WHERE id = 'mem-2'").run();
		});
		await supersede("pass-ext");

		const result = getDbAccessor().withWriteTx((db) => commitCuratedMemoryHeadInDb(db, input("pass-ext", [acme])));

		expect(result).toMatchObject({ ok: false, code: "STALE_HEAD" });
		expect(head().isCurrent).toBe(0);
	});

	it("does not let a caller-supplied pass id absorb writes made outside the pass", async () => {
		start("pass-route");
		await supersede("pass-route", false);

		const result = getDbAccessor().withWriteTx((db) => commitCuratedMemoryHeadInDb(db, input("pass-route", [acme])));

		expect(result).toMatchObject({ ok: false, code: "STALE_HEAD" });
	});

	it("shows the running pass its committed entries after its own writes stale the head", async () => {
		const weekly = {
			entryId: "weekly",
			text: "Acme ships weekly.",
			support: [{ source_ref: "memory:mem-2", quote: "Acme ships weekly." }],
		};
		start("pass-first");
		getDbAccessor().withWriteTx((db) => commitCuratedMemoryHeadInDb(db, input("pass-first", [weekly, acme])));
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE dreaming_passes SET status = 'completed' WHERE id = 'pass-first'").run();
		});
		start("pass-second");
		await supersede("pass-second");
		const read = (passId?: string) =>
			getDbAccessor().withWriteTx((db) =>
				executeMemoryHead(
					db,
					dir,
					passId === undefined
						? { action: "read", agentId: "agent-a" }
						: { action: "read", agentId: "agent-a", passId },
				),
			);

		const general = read();
		const own = read("pass-second");

		expect(general).toMatchObject({ status: "stale", content: null, entries: [] });
		expect(general).not.toHaveProperty("committedEntries");
		expect(own.committedEntries).toEqual([weekly, acme]);
		expect(
			getDbAccessor().withWriteTx((db) =>
				commitCuratedMemoryHeadInDb(db, input("pass-second", own.committedEntries as MemoryHeadCommitInput["entries"])),
			),
		).toMatchObject({ ok: true, code: "COMMITTED" });
		expect(head()).toMatchObject({ isCurrent: 1, content: `- Acme ships weekly.\n- ${quote}` });
	});

	it("never returns committed entries whose evidence is gone, and clears the head only when none survive", async () => {
		const weekly = {
			entryId: "weekly",
			text: "Acme ships weekly.",
			support: [{ source_ref: "memory:mem-2", quote: "Acme ships weekly." }],
		};
		start("pass-first");
		getDbAccessor().withWriteTx((db) => commitCuratedMemoryHeadInDb(db, input("pass-first", [weekly])));
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE dreaming_passes SET status = 'completed' WHERE id = 'pass-first'").run();
		});
		start("pass-lazy");
		expect(getDbAccessor().withWriteTx((db) => commitCuratedMemoryHeadInDb(db, input("pass-lazy", [])))).toMatchObject({
			ok: false,
			code: "INVALID_HEAD",
		});
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE dreaming_passes SET status = 'failed' WHERE id = 'pass-lazy'").run();
			db.prepare("DELETE FROM memories WHERE id = 'mem-2'").run();
		});
		start("pass-after-delete");

		const own = getDbAccessor().withWriteTx((db) =>
			executeMemoryHead(db, dir, { action: "read", agentId: "agent-a", passId: "pass-after-delete" }),
		);
		const cleared = getDbAccessor().withWriteTx((db) =>
			commitCuratedMemoryHeadInDb(db, input("pass-after-delete", [])),
		);

		expect(own.committedEntries).toEqual([]);
		expect(JSON.stringify(own)).not.toContain("Acme ships weekly.");
		expect(cleared).toMatchObject({ ok: true, code: "COMMITTED" });
		expect(head()).toMatchObject({ isCurrent: 1, content: "" });
	});

	it("leaves the head current after finalization rewrites the pass's transcript nodes", () => {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`INSERT INTO session_summaries
				 (id, project, depth, kind, content, token_count, earliest_at, latest_at, session_key, harness, agent_id, source_type, created_at)
				 VALUES ('summary-1', 'acme', 0, 'session', 'Old summary.', 2, datetime('now'), datetime('now'), 'session-1', 'claude-code', 'agent-a', 'summary', datetime('now'))`,
			).run();
		});
		start("pass-final");
		const finalize: DbOwnerDreamingPassFinalize = {
			passId: "pass-final",
			mode: "incremental-content",
			agentId: "agent-a",
			scopes: ["agent-a"],
			transcriptManifestEntries: [
				{
					scope: "agent-a",
					content: "User: Acme moved to edge runtime in Q2.",
					source: {
						id: "session-1",
						completed: true,
						project: "acme",
						harness: "claude-code",
						capturedAt: "2026-10-01T00:00:00.000Z",
					},
				},
			],
			tokensConsumed: 0,
			inputTokens: null,
			outputTokens: null,
			cacheReadTokens: null,
			cacheCreationTokens: null,
			peakContextTokens: null,
			totalCost: null,
			applied: 0,
			failed: 0,
			summary: "fixture",
			rejectedEvidence: [],
			memoryHeadCommitInput: input("pass-final", [acme]),
			hasBacklogByScope: [],
			nextWatermarkByScope: [],
		};

		getDbAccessor().withWriteTx((db) => finalizeDreamingPassInDb(db, finalize));

		expect(head()).toMatchObject({ isCurrent: 1, content: `- ${quote}` });
	});

	it("removes several retained entries in one commit", async () => {
		start("pass-first");
		const entries = ["one", "two", "three"].map((entryId) => ({ ...acme, entryId }));
		expect(
			getDbAccessor().withWriteTx((db) => commitCuratedMemoryHeadInDb(db, input("pass-first", entries))),
		).toMatchObject({ ok: true, code: "COMMITTED" });
		getDbAccessor().withWriteTx((db) => {
			db.prepare("UPDATE dreaming_passes SET status = 'completed' WHERE id = 'pass-first'").run();
		});
		start("pass-second");

		const result = getDbAccessor().withWriteTx((db) => commitCuratedMemoryHeadInDb(db, input("pass-second", [acme])));

		expect(result).toMatchObject({ ok: true, code: "COMMITTED" });
		const removed = getDbAccessor().withReadDb(
			(db) =>
				db
					.prepare(
						"SELECT entry_id FROM memory_head_revision_entries WHERE agent_id = 'agent-a' AND operation = 'remove' ORDER BY entry_id",
					)
					.all() as Array<{ entry_id: string }>,
		);
		expect(removed.map((row) => row.entry_id)).toEqual(["one", "three", "two"]);
	});
});
