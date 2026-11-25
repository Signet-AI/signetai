import { localAllReadScope } from "@signet/core";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbOwnerClient, type DbOwnerClient } from "./db-owner-client";
import { ownerReadOne, ownerRun } from "./db-owner-sql";
import { writeMemoryHead, type MemoryHeadRequest } from "./memory-head";

describe("memory head owner runtime", () => {
	let root: string;
	let client: DbOwnerClient;
	const options = { operation: "head-fixture", lane: "write" as const, deadlineMs: 10000 };
	const sql = (query: string, values: readonly unknown[] = []) => ownerRun(client, query, values, options);
	const head = (request: MemoryHeadRequest) =>
		client.submit<Record<string, unknown>>({ kind: "memory_head", request }, options).result;
	const snapshot = (agentId = "default") => head({ action: "read", agentId });
	const pass = (id: string, agentId = "default") =>
		sql("INSERT INTO dreaming_passes (id, agent_id, mode, status) VALUES (?, ?, 'incremental-content', 'running')", [
			id,
			agentId,
		]);
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
		await memory("meeting", "Meeting is Tuesday.");
	});
	afterEach(async () => {
		await client.close();
		rmSync(root, { recursive: true, force: true });
	});

	it("publishes once, withholds corrected text across restart, and regenerates on a later pass", async () => {
		expect(await commit("first")).toMatchObject({ ok: true, revision: 1 });
		const oldFile = readFileSync(join(root, "MEMORY.md"), "utf8");
		expect(oldFile).toContain("signet-generated-memory");
		expect(
			await head({
				readScope: localAllReadScope({ kind: "own", agentId: "default" }),
				action: "inspect",
				agentId: "default",
				content: oldFile,
			}),
		).toMatchObject({
			status: "current",
			content: "- Meeting is Tuesday.",
		});
		await sql("UPDATE memories SET content='Meeting is Thursday.' WHERE id='meeting'");
		expect(await snapshot()).toMatchObject({ status: "stale", revision: 2, entries: [] });
		expect(
			await head({
				readScope: localAllReadScope({ kind: "own", agentId: "default" }),
				action: "inspect",
				agentId: "default",
				content: oldFile,
			}),
		).toMatchObject({
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
		expect(
			await head({
				readScope: localAllReadScope({ kind: "own", agentId: "default" }),
				action: "inspect",
				agentId: "default",
				content: authored,
			}),
		).toMatchObject({
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

	const label = async (compartment: number) => {
		await sql(
			"INSERT OR IGNORE INTO classifications (id, name, created_at, updated_at) VALUES ('cls_hr', 'HR', datetime('now'), datetime('now'))",
		);
		await sql("INSERT OR IGNORE INTO compartments (id, key, created_at) VALUES (?, 'cls_hr', datetime('now'))", [
			compartment,
		]);
		await sql("INSERT OR IGNORE INTO compartment_members (compartment_id, classification_id) VALUES (?, 'cls_hr')", [
			compartment,
		]);
	};
	const outside = { reach: { kind: "own", agentId: "default" }, compartments: [], projects: null } as const;

	it("formats a restricted reader's generated head from readable entries only", async () => {
		await memory("salary", "Salary bands are HRSECRET.");
		await pass("labelled");
		await snapshot();
		expect(
			await head({
				action: "commit",
				input: {
					passId: "labelled",
					agentId: "default",
					entries: [
						{
							entryId: "meeting",
							text: "Meeting is Tuesday.",
							support: [{ source_ref: "memory:meeting", quote: "Meeting is Tuesday." }],
						},
						{
							entryId: "salary",
							text: "Salary bands are HRSECRET.",
							support: [{ source_ref: "memory:salary", quote: "Salary bands are HRSECRET." }],
						},
					],
				},
			}),
		).toMatchObject({ ok: true });
		await label(7);
		await sql("UPDATE memory_head_entries SET compartment_id=7 WHERE entry_id='salary'");
		await sql("UPDATE memory_head_revision_entries SET compartment_id=7 WHERE entry_id='salary'");
		const file = readFileSync(join(root, "MEMORY.md"), "utf8");
		expect(file).toContain("HRSECRET");
		expect(
			await head({
				action: "inspect",
				agentId: "default",
				content: `${file}\nHRSECRET edited projection`,
				readScope: outside,
			}),
		).toMatchObject({ content: "- Meeting is Tuesday." });
		expect(await head({ action: "inspect", agentId: "default", content: file, readScope: outside })).toEqual({
			generated: true,
			status: "current",
			content: "- Meeting is Tuesday.",
		});
		expect(
			await head({
				action: "inspect",
				agentId: "default",
				content: file,
				readScope: { ...outside, compartments: [7] },
			}),
		).toMatchObject({ content: "- Meeting is Tuesday.\n- Salary bands are HRSECRET." });
		expect(
			await head({
				action: "inspect",
				agentId: "default",
				content: file,
				readScope: { reach: { kind: "shared", agentId: "default" }, compartments: "all", projects: null },
			}),
		).toMatchObject({ content: "- Meeting is Tuesday.\n- Salary bands are HRSECRET." });
		expect(
			await head({
				action: "inspect",
				agentId: "default",
				content: file,
				readScope: { ...outside, compartments: [7], projects: ["atlas"] },
			}),
		).toMatchObject({ content: "" });
		expect(
			await head({
				action: "inspect",
				agentId: "default",
				content: file,
				readScope: { reach: { kind: "own", agentId: "other" }, compartments: "all", projects: null },
			}),
		).toMatchObject({ content: "" });
	});

	it("withholds authored head evidence from readers outside the agent label", async () => {
		const authored = "# My memory\nHRSECRET authored note.";
		await label(9);
		await sql(
			"INSERT INTO classification_assignments (target_kind, target_id, agent_id, classification_id, applied_by, applied_at) VALUES ('agent', 'default', 'default', 'cls_hr', 'test', datetime('now'))",
		);
		expect(await head({ action: "inspect", agentId: "default", content: authored, readScope: outside })).toMatchObject({
			status: "authored",
			content: null,
		});
		expect(
			await head({
				action: "inspect",
				agentId: "default",
				content: authored,
				readScope: { ...outside, compartments: [9] },
			}),
		).toMatchObject({ status: "authored", content: authored });
		expect(
			await head({
				action: "inspect",
				agentId: "default",
				content: authored,
				readScope: { ...outside, compartments: [9], projects: ["atlas"] },
			}),
		).toMatchObject({ content: null });
		expect(
			await head({
				readScope: localAllReadScope({ kind: "own", agentId: "default" }),
				action: "inspect",
				agentId: "default",
				content: authored,
			}),
		).toMatchObject({
			content: authored,
		});
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
		expect(
			await head({
				readScope: localAllReadScope({ kind: "own", agentId: "default" }),
				action: "inspect",
				agentId: "default",
				content: edited,
			}),
		).toMatchObject({
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
