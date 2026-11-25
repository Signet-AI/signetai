import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { up as migrateDreamingPartitions } from "../../core/src/migrations/179-dreaming-evidence-leases";
import { createDbOwnerClient, type DbOwnerClient } from "./db-owner-client";
import { ownerReadOne, ownerRun } from "./db-owner-sql";
import { withContentPassWrites } from "./memory-head-owner";
import { writeMemoryHead, type MemoryHeadRequest } from "./memory-head";

describe("memory head owner runtime", () => {
	let root: string;
	let client: DbOwnerClient;
	const options = { operation: "head-fixture", lane: "write" as const, deadlineMs: 10000 };
	const sql = (query: string, values: readonly unknown[] = []) => ownerRun(client, query, values, options);
	const head = (request: MemoryHeadRequest) =>
		client.submit<Record<string, unknown>>({ kind: "memory_head", request }, options).result;
	const snapshot = (agentId = "default") => head({ action: "read", agentId });
	const pass = (id: string, agentId = "default", compartmentId: number | null = null) =>
		sql(
			"INSERT INTO dreaming_passes (id, agent_id, compartment_id, mode, status) VALUES (?, ?, ?, 'incremental-content', 'running')",
			[id, agentId, compartmentId],
		);
	const partitions = async () => {
		await sql(
			"INSERT INTO classifications(id,name,created_at) VALUES ('hr','HR',datetime('now')),('eng','Engineering',datetime('now')),('other','Other',datetime('now'))",
		);
		await sql(
			"INSERT INTO compartments(id,key,created_at) VALUES (1,'hr',datetime('now')),(2,'eng',datetime('now')),(3,'eng,hr',datetime('now')),(4,'other',datetime('now'))",
		);
		await sql("INSERT INTO compartment_members VALUES (1,'hr'),(2,'eng'),(3,'hr'),(3,'eng'),(4,'other')");
	};
	const submitEntries = (
		passId: string,
		entries: Extract<MemoryHeadRequest, { action: "commit" }>["input"]["entries"],
	) => head({ action: "commit", input: { passId, agentId: "default", entries } });

	const memory = (id: string, content: string, agentId = "default") =>
		sql(
			"INSERT INTO memories (id, content, agent_id, memory_kind, type, visibility, created_at, updated_at) VALUES (?, ?, ?, 'episodic', 'fact', 'private', datetime('now'), datetime('now'))",
			[id, content, agentId],
		);
	async function commit(id: string, text = "Meeting is Tuesday.", agentId = "default") {
		await pass(id, agentId);
		await snapshot(agentId);
		return head({
			action: "commit",
			input: {
				passId: id,
				agentId,
				entries: [{ entryId: "meeting", text, support: [{ source_ref: "memory:meeting", quote: text }] }],
			},
		});
	}

	beforeEach(async () => {
		root = mkdtempSync(join(tmpdir(), "signet-head-owner-"));
		mkdirSync(join(root, "memory"));
		client = createDbOwnerClient({ dbPath: join(root, "memory", "memories.db") });
		await client.initialize(root);
		await client.close();
		const db = new Database(join(root, "memory", "memories.db"));
		try {
			migrateDreamingPartitions(db);
		} finally {
			db.close();
		}
		client = createDbOwnerClient({ dbPath: join(root, "memory", "memories.db") });
		await memory("meeting", "Meeting is Tuesday.");
	});
	afterEach(async () => {
		await client.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("keeps classified head streams out of the public projection and public revision fence", async () => {
		await partitions();
		await memory("secret", "Confidential meeting.");
		await sql("UPDATE memories SET compartment_id=1 WHERE id='secret'");
		await pass("public");
		await pass("classified", "default", 1);
		expect(
			await head({
				action: "commit",
				input: {
					agentId: "default",
					passId: "classified",
					entries: [
						{
							entryId: "secret",
							text: "Confidential meeting.",
							support: [{ source_ref: "memory:secret", quote: "Confidential meeting." }],
						},
					],
				},
			}),
		).toMatchObject({ ok: true });
		expect(existsSync(join(root, "MEMORY.md"))).toBe(false);
		expect(await snapshot()).toMatchObject({ revision: 0, content: null, entries: [] });
		expect(await head({ action: "read", agentId: "default", passId: "classified" })).toMatchObject({
			content: "- Confidential meeting.",
			entries: [expect.objectContaining({ entry_id: "secret" })],
		});
		expect(
			await head({
				action: "commit",
				input: {
					agentId: "default",
					passId: "public",
					entries: [
						{
							entryId: "meeting",
							text: "Meeting is Tuesday.",
							support: [{ source_ref: "memory:meeting", quote: "Meeting is Tuesday." }],
						},
					],
				},
			}),
		).toMatchObject({ ok: true, revision: 1 });
		expect(readFileSync(join(root, "MEMORY.md"), "utf8")).not.toContain("Confidential");
		expect(await head({ action: "read", agentId: "default", passId: "classified" })).toMatchObject({
			content: "- Confidential meeting.",
			status: "current",
			readableEntries: [expect.objectContaining({ entry_id: "meeting", compartment_id: null })],
		});
		await sql("UPDATE memories SET content='Revised confidential meeting.' WHERE id='secret'");
		expect(await snapshot()).toMatchObject({ content: "- Meeting is Tuesday.", revision: 1, status: "current" });
		expect(readFileSync(join(root, "MEMORY.md"), "utf8")).not.toContain("Confidential");
	});

	it("validates subset evidence for every source kind and persists pass labels and copy citations", async () => {
		await partitions();
		await memory("subset", "Subset evidence");
		await sql("UPDATE memories SET compartment_id=1 WHERE id='subset'");
		await sql(
			"INSERT INTO memory_artifacts(source_path,source_sha256,source_kind,session_id,session_token,content,agent_id,compartment_id,captured_at,updated_at) VALUES ('artifact','sha','note','s','s','Artifact evidence','default',2,datetime('now'),datetime('now'))",
		);
		await sql(
			"INSERT INTO session_transcripts(session_key,content,agent_id,compartment_id,created_at,completed_at) VALUES ('transcript','Transcript evidence','default',3,datetime('now'),datetime('now'))",
		);
		await sql(
			"INSERT INTO session_summaries(id,content,agent_id,compartment_id,depth,kind,token_count,earliest_at,latest_at,created_at) VALUES ('summary','Summary evidence','default',NULL,0,'session',3,datetime('now'),datetime('now'),datetime('now'))",
		);
		await pass("union", "default", 3);
		const entries = [
			{ entryId: "subset", text: "Subset", support: [{ source_ref: "memory:subset", quote: "Subset evidence" }] },
			{
				entryId: "artifact",
				text: "Artifact",
				support: [{ source_ref: "artifact:artifact", quote: "Artifact evidence" }],
			},
			{
				entryId: "transcript",
				text: "Transcript",
				support: [{ source_ref: "transcript:transcript", quote: "Transcript evidence" }],
			},
			{ entryId: "summary", text: "Summary", support: [{ source_ref: "summary:summary", quote: "Summary evidence" }] },
		];
		expect(await submitEntries("union", entries)).toMatchObject({ ok: true });
		expect(
			await ownerReadOne(
				client,
				"SELECT COUNT(*) AS n FROM memory_head_entries WHERE compartment_id=3 AND pass_id='union'",
				[],
				options,
			),
		).toEqual({ n: 4 });
		expect(
			await ownerReadOne(
				client,
				"SELECT COUNT(*) AS n FROM memory_head_revision_entries e JOIN memory_head_revisions r ON r.id=e.revision_id WHERE e.compartment_id=3 AND r.compartment_id=3 AND e.pass_id='union'",
				[],
				options,
			),
		).toEqual({ n: 4 });
		expect(
			await ownerReadOne(client, "SELECT compartment_id,status FROM memory_head_publications", [], options),
		).toEqual({ compartment_id: 3, status: "completed" });
		expect(
			await ownerReadOne(
				client,
				"SELECT COUNT(*) AS n FROM evidence_citations WHERE derived_kind='head_entry'",
				[],
				options,
			),
		).toEqual({ n: 4 });
		expect(
			await ownerReadOne(
				client,
				"SELECT COUNT(*) AS n FROM evidence_citations WHERE derived_kind='head_revision' AND evidence_kind='attribute'",
				[],
				options,
			),
		).toEqual({ n: 4 });
		await pass("foreign", "other", 3);
		for (const entry of entries)
			expect(
				await head({ action: "commit", input: { agentId: "other", passId: "foreign", entries: [entry] } }),
			).toMatchObject({ ok: false, code: "INVALID_PROVENANCE" });
		await pass("public");
		for (const entry of entries.slice(0, 3))
			expect(await submitEntries("public", [{ ...entry, entryId: `public-${entry.entryId}` }])).toMatchObject({
				ok: false,
				code: "INVALID_PROVENANCE",
			});
		await sql("UPDATE memories SET compartment_id=4 WHERE id='subset'");
		await pass("union-later", "default", 3);
		expect(await submitEntries("union-later", entries)).toMatchObject({ ok: false, code: "INVALID_PROVENANCE" });
	});

	it("rejects entry relabeling and stale epochs before durable or file side effects", async () => {
		await partitions();
		expect(await commit("public")).toMatchObject({ ok: true });
		const projection = readFileSync(join(root, "MEMORY.md"), "utf8");
		await pass("classified", "default", 1);
		await expect(
			submitEntries("classified", [
				{
					entryId: "meeting",
					text: "Changed",
					support: [{ source_ref: "memory:meeting", quote: "Meeting is Tuesday." }],
				},
			]),
		).rejects.toThrow("compartment_mismatch");
		expect(await ownerReadOne(client, "SELECT COUNT(*) AS n FROM memory_head_revisions", [], options)).toEqual({
			n: 1,
		});
		await pass("epoch");
		await sql(
			"INSERT INTO classification_assignments VALUES ('memory','meeting','default','hr','operator',datetime('now'))",
		);
		await expect(
			submitEntries("epoch", [
				{ entryId: "new", text: "Changed", support: [{ source_ref: "memory:meeting", quote: "Meeting is Tuesday." }] },
			]),
		).rejects.toThrow("compartment_mismatch");
		await expect(head({ action: "read", agentId: "default", passId: "epoch" })).rejects.toThrow("compartment_mismatch");
		expect(await ownerReadOne(client, "SELECT COUNT(*) AS n FROM memory_head_revisions", [], options)).toEqual({
			n: 1,
		});
		expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(projection);
	});

	it("keeps same-label revision fencing across owner restart without clobbering another stream", async () => {
		await partitions();
		await pass("winner", "default", 1);
		await pass("loser", "default", 1);
		const entry = {
			entryId: "classified",
			text: "Meeting",
			support: [{ source_ref: "memory:meeting", quote: "Meeting is Tuesday." }],
		};
		expect(await submitEntries("winner", [entry])).toMatchObject({ ok: true, revision: 1 });
		expect(await submitEntries("loser", [entry])).toMatchObject({ ok: false, code: "STALE_HEAD" });
		await client.close();
		client = createDbOwnerClient({ dbPath: join(root, "memory", "memories.db") });
		await pass("later", "default", 1);
		expect(await head({ action: "read", agentId: "default", passId: "later" })).toMatchObject({
			content: "- Meeting",
			revision: 1,
		});
		expect(await submitEntries("later", [{ ...entry, text: "Tuesday meeting" }])).toMatchObject({
			ok: true,
			revision: 2,
		});
		expect(await snapshot()).toMatchObject({ content: null, revision: 0 });
		expect(existsSync(join(root, "MEMORY.md"))).toBe(false);
	});

	it("withholds a rendered revision after its cited entry moves to another label", async () => {
		await partitions();
		expect(await commit("original")).toMatchObject({ ok: true });
		const target = join(root, "MEMORY.md");
		const oldFile = readFileSync(target, "utf8");
		await sql("UPDATE memory_head_entries SET compartment_id=1 WHERE entry_id='meeting'");
		await sql("UPDATE memory_head_revision_entries SET compartment_id=1 WHERE entry_id='meeting'");
		rmSync(target);
		expect(await snapshot()).toMatchObject({ content: null, entries: [], status: "stale" });
		expect(await head({ action: "inspect", agentId: "default", content: oldFile })).toMatchObject({
			content: null,
			status: "stale",
		});
		expect(existsSync(target)).toBe(false);
	});

	it("advances only the writing pass fence for a same-label evidence edit", async () => {
		await partitions();
		await memory("scoped", "Original evidence");
		await sql("UPDATE memories SET compartment_id=1 WHERE id='scoped'");
		await pass("writer", "default", 1);
		await pass("peer", "default", 1);
		await pass("public");
		await client.close();
		const db = new Database(join(root, "memory", "memories.db"));
		try {
			withContentPassWrites(db, "writer", () =>
				db.prepare("UPDATE memories SET content='Changed evidence' WHERE id='scoped'").run(),
			);
		} finally {
			db.close();
		}
		client = createDbOwnerClient({ dbPath: join(root, "memory", "memories.db") });
		const entries = [
			{ entryId: "scoped", text: "Changed", support: [{ source_ref: "memory:scoped", quote: "Changed evidence" }] },
		];
		expect(await submitEntries("writer", entries)).toMatchObject({ ok: true });
		expect(await submitEntries("peer", entries)).toMatchObject({ ok: false, code: "STALE_HEAD" });
		expect(
			await submitEntries("public", [
				{
					entryId: "meeting",
					text: "Tuesday",
					support: [{ source_ref: "memory:meeting", quote: "Meeting is Tuesday." }],
				},
			]),
		).toMatchObject({ ok: true });
	});

	it("publishes once, withholds corrected text across restart, and regenerates on a later pass", async () => {
		expect(await commit("first")).toMatchObject({ ok: true, revision: 1 });
		const oldFile = readFileSync(join(root, "MEMORY.md"), "utf8");
		expect(oldFile).toContain("signet-generated-memory");
		expect(await head({ action: "inspect", agentId: "default", content: oldFile })).toMatchObject({
			status: "current",
			content: "- Meeting is Tuesday.",
		});
		await sql("UPDATE memories SET content='Meeting is Thursday.' WHERE id='meeting'");
		expect(await snapshot()).toMatchObject({ status: "stale", revision: 2, entries: [] });
		expect(await head({ action: "inspect", agentId: "default", content: oldFile })).toMatchObject({
			status: "stale",
			content: null,
		});
		await client.close();
		client = createDbOwnerClient({ dbPath: join(root, "memory", "memories.db") });
		expect(await snapshot()).toMatchObject({ status: "stale", revision: 2 });
		expect(await commit("regenerate", "Meeting is Thursday.", "default")).toMatchObject({
			ok: true,
			revision: 3,
		});
		expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toContain("Thursday");
		expect(await snapshot()).toMatchObject({
			content: "- Meeting is Thursday.",
			entries: [expect.objectContaining({ entry_id: "meeting" })],
		});
		expect(
			await ownerReadOne(client, "SELECT content FROM memory_head_revisions WHERE revision=1", [], options),
		).toEqual({ content: "- Meeting is Tuesday." });
	});

	it("fences a commit even when stale work reads a new base after correction", async () => {
		await pass("queued");
		await sql("UPDATE memories SET content='Meeting is Thursday.' WHERE id='meeting'");
		await snapshot();
		const common = {
			passId: "queued",
			agentId: "default",
		};
		expect(
			await head({
				action: "commit",
				input: {
					...common,
					entries: [
						{ entryId: "meeting", text: "Tuesday", support: [{ source_ref: "memory:meeting", quote: "Tuesday" }] },
					],
				},
			}),
		).toMatchObject({ ok: false, code: "STALE_HEAD" });
		expect(existsSync(join(root, "MEMORY.md"))).toBe(false);
	});

	it("preserves authored files and records structured provenance", async () => {
		const authored = "# My memory\nKeep this wording.";
		writeFileSync(join(root, "MEMORY.md"), authored);
		expect(writeMemoryHead("Unversioned generated text")).toMatchObject({ ok: false, code: "invalid" });
		expect(await commit("authored", "Meeting is Tuesday.", "default")).toMatchObject({
			ok: false,
			code: "PUBLICATION_PENDING",
			revision: 1,
		});
		expect(await snapshot()).toMatchObject({ status: "current" });
		expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(authored);
		expect(await head({ action: "inspect", agentId: "default", content: authored })).toMatchObject({
			generated: false,
			status: "authored",
			content: authored,
		});
		expect(
			await ownerReadOne(
				client,
				"SELECT operation, provenance_json FROM memory_head_revision_entries WHERE revision=1",
				[],
				options,
			),
		).toEqual({ operation: "add", provenance_json: '[{"source_ref":"memory:meeting","quote":"Meeting is Tuesday."}]' });
	});

	it("rejects retired owner requests without changing the head", async () => {
		await pass("retired");
		await expect(
			head(
				JSON.parse(
					JSON.stringify({
						action: "curate",
						input: {
							passId: "retired",
							agentId: "default",
							content: "Meeting is Tuesday.",
							entries: [
								{
									id: "meeting",
									text: "Meeting is Tuesday.",
									operation: "added",
									sourceRefs: ["memory:meeting"],
									supportingQuotes: ["Meeting is Tuesday."],
								},
							],
						},
					}),
				),
			),
		).rejects.toThrow("Unsupported memory head action");
		expect(await snapshot()).toMatchObject({ revision: 0, status: "stale" });
		expect(existsSync(join(root, "MEMORY.md"))).toBe(false);
	});

	it("preserves historical freeform audits when structured publication replaces the head", async () => {
		await pass("historical");
		await sql(
			"INSERT INTO memory_head_revisions (id, agent_id, revision, content, content_hash, rendered_token_count, base_revision, base_hash, pass_id, entry_id, entry_text, operation, source_refs_json, supporting_quotes_json, created_at) VALUES ('old-audit', 'default', 1, 'Meeting is Tuesday.', 'old-hash', 5, 0, '', 'historical', 'meeting', 'Meeting is Tuesday.', 'deferred', '[\"memory:meeting\"]', '[\"Meeting is Tuesday.\"]', datetime('now'))",
		);
		await sql(
			"UPDATE memory_md_heads SET revision=1, content='Meeting is Tuesday.', content_hash='old-hash', revision_id='old-audit', is_current=0 WHERE agent_id='default'",
		);
		const before = await ownerReadOne(client, "SELECT * FROM memory_head_revisions WHERE id='old-audit'", [], options);
		expect(await commit("new-format")).toMatchObject({ ok: true, revision: 2 });
		expect(await ownerReadOne(client, "SELECT * FROM memory_head_revisions WHERE id='old-audit'", [], options)).toEqual(
			before,
		);
		expect(await snapshot()).toMatchObject({ status: "current", content: "- Meeting is Tuesday." });
	});

	it("does not invalidate on ingestion or unrelated private changes, but deletion fences pending work", async () => {
		expect(await commit("first")).toMatchObject({ ok: true, revision: 1 });
		await memory("other", "Private note", "other");
		await sql("UPDATE memories SET content='Changed private note' WHERE id='other'");
		await memory("new", "New evidence");
		expect(await snapshot()).toMatchObject({ status: "current", revision: 1 });
		await pass("queued");
		await sql("DELETE FROM memories WHERE id='meeting'");
		expect(await snapshot()).toMatchObject({ status: "stale", revision: 2 });
		expect(await commit("missing")).toMatchObject({ ok: false, code: "INVALID_PROVENANCE" });
	});

	it("clears the head and its projection once no committed entry keeps its evidence", async () => {
		expect(await commit("first")).toMatchObject({ ok: true, revision: 1 });
		expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toContain("Tuesday");
		await sql("DELETE FROM memories WHERE id='meeting'");
		await pass("clear");

		const result = await head({ action: "commit", input: { passId: "clear", agentId: "default", entries: [] } });

		expect(result).toMatchObject({ ok: true, code: "COMMITTED" });
		expect(await snapshot()).toMatchObject({ status: "current", content: "" });
		expect(readFileSync(join(root, "MEMORY.md"), "utf8")).not.toContain("Tuesday");
	});

	it("rolls back database changes and leaves the projection intact when audit insertion fails", async () => {
		expect(await commit("first")).toMatchObject({ ok: true });
		const previous = readFileSync(join(root, "MEMORY.md"), "utf8");
		await sql("UPDATE memories SET content='Meeting is Thursday.' WHERE id='meeting'");
		await sql(
			"CREATE TRIGGER fail_head_audit BEFORE INSERT ON memory_head_revision_entries BEGIN SELECT RAISE(ABORT, 'audit rejected'); END",
		);
		await expect(commit("failed", "Meeting is Thursday.")).rejects.toThrow("audit rejected");
		await sql("DROP TRIGGER fail_head_audit");
		await sql(
			"CREATE TRIGGER fail_head_citation BEFORE INSERT ON evidence_citations WHEN NEW.derived_kind='head_revision' BEGIN SELECT RAISE(ABORT, 'citation rejected'); END",
		);
		await expect(commit("failed-citation", "Meeting is Thursday.")).rejects.toThrow("citation rejected");
		expect(
			await ownerReadOne(
				client,
				"SELECT COUNT(*) AS n FROM evidence_citations WHERE derived_kind='head_revision'",
				[],
				options,
			),
		).toEqual({ n: 2 });
		expect(readFileSync(join(root, "MEMORY.md"), "utf8")).toBe(previous);
		expect(await snapshot()).toMatchObject({ status: "stale", revision: 2 });
		expect(await ownerReadOne(client, "SELECT COUNT(*) AS count FROM memory_head_revisions", [], options)).toEqual({
			count: 1,
		});
	});

	it("keeps structured entry removal and evidence audit in the same publication", async () => {
		expect(await commit("first")).toMatchObject({ ok: true });
		await pass("replace-entry");
		await snapshot();
		expect(
			await head({
				action: "commit",
				input: {
					agentId: "default",
					passId: "replace-entry",
					entries: [
						{
							entryId: "new-entry",
							text: "Tuesday meeting",
							support: [{ source_ref: "memory:meeting", quote: "Meeting is Tuesday." }],
						},
					],
				},
			}),
		).toMatchObject({ ok: true });
		expect(
			await ownerReadOne(client, "SELECT status FROM memory_head_entries WHERE entry_id='meeting'", [], options),
		).toEqual({ status: "removed" });
		expect(
			await ownerReadOne(
				client,
				"SELECT operation FROM memory_head_revision_entries WHERE entry_id='meeting' AND revision=2",
				[],
				options,
			),
		).toEqual({ operation: "remove" });
	});

	it("replaces a generated file whose revision this database never recorded", async () => {
		const target = join(root, "MEMORY.md");
		writeFileSync(
			target,
			"<!-- signet-generated-memory agent=default revision=97; inspect only, use Signet for current context -->\n\n- Old head.\n",
		);
		expect(await commit("unrecorded")).toMatchObject({ ok: true, code: "COMMITTED", revision: 1 });
		expect(readFileSync(target, "utf8")).toContain("- Meeting is Tuesday.");
	});

	it("recovers a pending projection without generation and preserves edits to a generated file", async () => {
		const target = join(root, "MEMORY.md");
		mkdirSync(target);
		expect(await commit("pending")).toMatchObject({ ok: false, code: "PUBLICATION_PENDING" });
		rmSync(target, { recursive: true });
		expect(await snapshot()).toMatchObject({ status: "current", revision: 1 });
		const generated = readFileSync(target, "utf8");
		const edited = generated.replace("Meeting is Tuesday.", "My own wording.");
		writeFileSync(target, edited);
		await snapshot();
		expect(readFileSync(target, "utf8")).toBe(edited);
		expect(await head({ action: "inspect", agentId: "default", content: edited })).toMatchObject({
			generated: false,
			status: "authored",
			content: edited,
		});
		expect(await ownerReadOne(client, "SELECT COUNT(*) AS count FROM memory_head_revisions", [], options)).toEqual({
			count: 1,
		});
	});

	it("cannot publish open transcripts and fences a completed transcript if it is reopened", async () => {
		await sql(
			"INSERT INTO session_transcripts (session_key, content, agent_id, created_at, updated_at) VALUES ('head-session', 'Meeting is Tuesday.', 'default', datetime('now'), datetime('now'))",
		);
		async function fromTranscript(passId: string) {
			await pass(passId);
			await snapshot();
			return head({
				action: "commit",
				input: {
					agentId: "default",
					passId,
					entries: [
						{
							entryId: "meeting",
							text: "Tuesday meeting",
							support: [{ source_ref: "transcript:head-session", quote: "Meeting is Tuesday." }],
						},
					],
				},
			});
		}
		expect(await fromTranscript("open")).toMatchObject({ ok: false, code: "INVALID_PROVENANCE" });
		await sql("UPDATE session_transcripts SET completed_at=datetime('now') WHERE session_key='head-session'");
		expect(await fromTranscript("closed")).toMatchObject({ ok: true });
		await sql("UPDATE session_transcripts SET completed_at=NULL WHERE session_key='head-session'");
		expect(await snapshot()).toMatchObject({ status: "stale", revision: 2 });
	});

	it("rejects oversized, cross-scope and obsolete evidence before publishing", async () => {
		expect(await commit("oversized", "alpha beta gamma ".repeat(1500))).toMatchObject({ ok: false });
		expect(await commit("foreign", "Meeting is Tuesday.", "other")).toMatchObject({
			ok: false,
			code: "INVALID_PROVENANCE",
		});
		await sql("UPDATE memories SET stale_at=datetime('now') WHERE id='meeting'");
		expect(await commit("obsolete")).toMatchObject({ ok: false, code: "INVALID_PROVENANCE" });
		expect(existsSync(join(root, "MEMORY.md"))).toBe(false);
		await client.close();
		await expect(Promise.resolve().then(() => snapshot())).rejects.toThrow();
	});
});
