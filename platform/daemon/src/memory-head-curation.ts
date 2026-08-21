import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDefaultBasePath, scanMemoryContent } from "@signet/core";
import { getDbAccessor } from "./db-accessor";
import { countTokens } from "./pipeline/tokenizer";
import { renderDreamingEvidence } from "./pipeline/dreaming-evidence";
import { readEpisodicSource } from "./episodic-sources";

export const CURATED_MEMORY_HEAD_MAX_TOKENS = 1000;

type Entry = { readonly entryId: string; readonly text: string; readonly support: readonly Record<string, unknown>[] };
export type MemoryHeadResult = {
	readonly ok: boolean;
	readonly code?: string;
	readonly error?: string;
	readonly revision?: number;
	readonly hash?: string;
	readonly changedIds?: readonly string[];
};

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const pathFor = (agentId: string): string =>
	agentId === "default"
		? join(resolveDefaultBasePath(), "MEMORY.md")
		: join(resolveDefaultBasePath(), "agents", agentId, "MEMORY.md");
const render = (entries: readonly Entry[]): string => entries.map((entry) => `- ${entry.text.trim()}`).join("\n");

export async function readCuratedMemoryHead(agentId: string): Promise<Record<string, unknown>> {
	if (!agentId.trim()) throw new Error("agentId is required");
	const snapshot = await getDbAccessor().withReadDbAsync((db) => {
		const head = db
			.prepare("SELECT revision, content, content_hash, revision_id FROM memory_md_heads WHERE agent_id = ?")
			.get(agentId) as Record<string, unknown> | undefined;
		const entries = db
			.prepare(
				"SELECT entry_id, canonical_text, status FROM memory_head_entries WHERE agent_id = ? AND status = 'active' ORDER BY entry_id",
			)
			.all(agentId);
		const revision = head?.revision ?? 0;
		const pending = db
			.prepare("SELECT status FROM memory_head_publications WHERE agent_id = ? AND revision = ?")
			.get(agentId, revision) as { status?: string } | undefined;
		return { head, entries, pending };
	}, { siteToken: "memory-head-curation.ts:31" });
	const head = snapshot.head;
	const content = typeof head?.content === "string" ? head.content : "";
	if (content) {
		const target = pathFor(agentId);
		mkdirSync(dirname(target), { recursive: true });
		let existing = "";
		try {
			existing = readFileSync(target, "utf8");
		} catch {}
		if (existing !== `${content}\n`) {
			const temporary = `${target}.recovery-${String(head?.revision ?? 0)}.tmp`;
			writeFileSync(temporary, `${content}\n`, "utf8");
			renameSync(temporary, target);
		}
		if (snapshot.pending?.status === "pending") {
			await getDbAccessor().withWriteTxAsync((writeDb) => {
				writeDb
					.prepare(
						"UPDATE memory_head_publications SET status='completed', completed_at=? WHERE agent_id=? AND revision=?",
					)
					.run(new Date().toISOString(), agentId, head?.revision ?? 0);
			}, { siteToken: "memory-head-curation.ts:61" });
		}
	}
	return {
		agentId,
		revision: head?.revision ?? 0,
		hash: head?.content_hash ?? "",
		revisionId: head?.revision_id ?? null,
		entries: snapshot.entries,
	};
}

export async function commitCuratedMemoryHead(input: {
	readonly agentId: string;
	readonly passId: string;
	readonly baseRevision: number;
	readonly baseHash: string;
	readonly entries: readonly Entry[];
}): Promise<MemoryHeadResult> {
	if (!input.agentId.trim() || !input.passId.trim())
		return { ok: false, code: "INVALID_SCOPE", error: "agentId and passId are required" };
	const body = render(input.entries);
	if (!body.trim()) return { ok: false, code: "EMPTY_HEAD", error: "curated head cannot be empty" };
	const safety = scanMemoryContent(body);
	if (!safety.contextEligible) return { ok: false, code: "UNSAFE_HEAD", error: safety.reasons.join(", ") };
	if (countTokens(body) > CURATED_MEMORY_HEAD_MAX_TOKENS)
		return { ok: false, code: "TOKEN_BUDGET_EXCEEDED", error: "curated head exceeds 1000 tokens" };
	const contentHash = hash(body);
	const committed = await getDbAccessor().withWriteTxAsync((db) => {
		const pass = db.prepare("SELECT mode, status, agent_id FROM dreaming_passes WHERE id = ?").get(input.passId) as
			| { mode?: string; status?: string; agent_id?: string }
			| undefined;
		if (pass?.status !== "running" || pass.mode !== "incremental-content" || pass.agent_id !== input.agentId)
			return {
				ok: false,
				code: "PASS_NOT_AUTHORIZED",
				error: "only a running content pass may commit the memory head",
			};
		const current = db
			.prepare("SELECT revision, content_hash FROM memory_md_heads WHERE agent_id = ?")
			.get(input.agentId) as { revision: number; content_hash: string } | undefined;
		const revision = current?.revision ?? 0;
		const currentHash = current?.content_hash ?? "";
		if (revision !== input.baseRevision || currentHash !== input.baseHash)
			return {
				ok: false,
				code: "STALE_HEAD",
				error: "memory head changed since it was read",
				revision,
				hash: currentHash,
			};
		if (currentHash === contentHash) return { ok: true, code: "NOOP", revision, hash: contentHash, changedIds: [] };
		for (const entry of input.entries) {
			if (entry.support.length === 0)
				return { ok: false, code: "MISSING_PROVENANCE", error: `entry ${entry.entryId} has no evidence` };
			for (const support of entry.support) {
				const sourceRef =
					typeof support.source_ref === "string"
						? support.source_ref
						: typeof support.sourceRef === "string"
							? support.sourceRef
							: "";
				const quote = typeof support.quote === "string" ? support.quote.trim() : "";
				if (
					!quote ||
					sourceRef.startsWith("attention:") ||
					!/^(memory|artifact|transcript|summary):.+$/.test(sourceRef)
				)
					return {
						ok: false,
						code: "INVALID_PROVENANCE",
						error: `entry ${entry.entryId} requires scoped exact evidence`,
					};
				const source = readEpisodicSource(db, { agentId: input.agentId, from: sourceRef });
				if (source === null || !renderDreamingEvidence(source).includes(quote))
					return {
						ok: false,
						code: "INVALID_PROVENANCE",
						error: `entry ${entry.entryId} quote is not exact scoped evidence`,
					};
			}
		}
		const nextRevision = revision + 1;
		const revisionId = randomUUID();
		const now = new Date().toISOString();
		db.prepare(
			"INSERT INTO memory_head_revisions (id, agent_id, revision, content, content_hash, rendered_token_count, pass_id, base_revision, base_hash, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			revisionId,
			input.agentId,
			nextRevision,
			body,
			contentHash,
			countTokens(body),
			input.passId,
			revision,
			currentHash,
			now,
		);
		for (const [ordinal, entry] of input.entries.entries()) {
			const entryHash = hash(entry.text.trim());
			db.prepare(
				"INSERT INTO memory_head_entries (entry_id, agent_id, canonical_text, entry_hash, status, first_revision, last_revision, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(agent_id, entry_id) DO UPDATE SET canonical_text=excluded.canonical_text, entry_hash=excluded.entry_hash, status='active', last_revision=excluded.last_revision, updated_at=excluded.updated_at",
			).run(entry.entryId, input.agentId, entry.text.trim(), entryHash, nextRevision, nextRevision, now, now);
			db.prepare(
				"INSERT INTO memory_head_revision_entries (agent_id, revision, entry_id, ordinal, operation, provenance_json) VALUES (?, ?, ?, ?, 'add', ?)",
			).run(input.agentId, nextRevision, entry.entryId, ordinal, JSON.stringify(entry.support));
		}
		const activeEntries = db
			.prepare("SELECT entry_id FROM memory_head_entries WHERE agent_id = ? AND status = 'active'")
			.all(input.agentId) as Array<{ entry_id: string }>;
		const retained = new Set(input.entries.map((entry) => entry.entryId));
		for (const old of activeEntries) {
			if (retained.has(old.entry_id)) continue;
			db.prepare(
				"UPDATE memory_head_entries SET status='removed', last_revision=?, updated_at=? WHERE agent_id=? AND entry_id=?",
			).run(nextRevision, now, input.agentId, old.entry_id);
			db.prepare(
				"INSERT INTO memory_head_revision_entries (agent_id, revision, entry_id, ordinal, operation, provenance_json) VALUES (?, ?, ?, ?, 'remove', '[]')",
			).run(input.agentId, nextRevision, old.entry_id, input.entries.length);
		}
		db.prepare(
			"INSERT OR IGNORE INTO memory_md_heads (agent_id, content, content_hash, revision, updated_at) VALUES (?, '', '', 0, ?)",
		).run(input.agentId, now);
		db.prepare(
			"UPDATE memory_md_heads SET content=?, content_hash=?, revision=?, revision_id=?, pass_id=?, updated_at=? WHERE agent_id=?",
		).run(body, contentHash, nextRevision, revisionId, input.passId, now, input.agentId);
		db.prepare(
			"INSERT INTO memory_head_publications (agent_id, revision, revision_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
		).run(input.agentId, nextRevision, revisionId, now);
		return {
			ok: true,
			code: "COMMITTED",
			revision: nextRevision,
			hash: contentHash,
			changedIds: input.entries.map((entry) => entry.entryId),
		};
	}, { siteToken: "memory-head-curation.ts:95" });
	if (!committed.ok || committed.code !== "COMMITTED" || committed.revision === undefined) return committed;
	const target = pathFor(input.agentId);
	mkdirSync(dirname(target), { recursive: true });
	const temporary = `${target}.curated-${committed.revision}.tmp`;
	try {
		writeFileSync(temporary, `${body}\n`, "utf8");
		renameSync(temporary, target);
	} catch (error) {
		return {
			...committed,
			ok: false,
			code: "PUBLICATION_PENDING",
			error: error instanceof Error ? error.message : String(error),
		};
	}
	try {
		await getDbAccessor().withWriteTxAsync((db) => {
			db.prepare(
				"UPDATE memory_head_publications SET status='completed', completed_at=? WHERE agent_id=? AND revision=?",
			).run(new Date().toISOString(), input.agentId, committed.revision);
		}, { siteToken: "memory-head-curation.ts:221" });
	} catch (error) {
		return {
			...committed,
			ok: false,
			code: "PUBLICATION_PENDING",
			error: error instanceof Error ? error.message : String(error),
		};
	}
	return committed;
}
