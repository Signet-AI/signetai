import { createHash, randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDefaultBasePath, scanMemoryContent } from "@signet/core";
import { getDbAccessor } from "./db-accessor";
import { countTokens } from "./pipeline/tokenizer";

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

export function readCuratedMemoryHead(agentId: string): Record<string, unknown> {
	if (!agentId.trim()) throw new Error("agentId is required");
	return getDbAccessor().withReadDb((db) => {
		const head = db
			.prepare("SELECT revision, content_hash, revision_id FROM memory_md_heads WHERE agent_id = ?")
			.get(agentId) as Record<string, unknown> | undefined;
		const entries = db
			.prepare(
				"SELECT entry_id, canonical_text, status FROM memory_head_entries WHERE agent_id = ? AND status = 'active' ORDER BY entry_id",
			)
			.all(agentId);
		return {
			agentId,
			revision: head?.revision ?? 0,
			hash: head?.content_hash ?? "",
			revisionId: head?.revision_id ?? null,
			entries,
		};
	});
}

export function commitCuratedMemoryHead(input: {
	readonly agentId: string;
	readonly passId: string;
	readonly baseRevision: number;
	readonly baseHash: string;
	readonly entries: readonly Entry[];
}): MemoryHeadResult {
	if (!input.agentId.trim() || !input.passId.trim())
		return { ok: false, code: "INVALID_SCOPE", error: "agentId and passId are required" };
	const body = render(input.entries);
	if (!body.trim()) return { ok: false, code: "EMPTY_HEAD", error: "curated head cannot be empty" };
	const safety = scanMemoryContent(body);
	if (!safety.contextEligible) return { ok: false, code: "UNSAFE_HEAD", error: safety.reasons.join(", ") };
	if (countTokens(body) > CURATED_MEMORY_HEAD_MAX_TOKENS)
		return { ok: false, code: "TOKEN_BUDGET_EXCEEDED", error: "curated head exceeds 1000 tokens" };
	const contentHash = hash(body);
	return getDbAccessor().withWriteTx((db) => {
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
				"INSERT INTO memory_head_entries (entry_id, agent_id, canonical_text, entry_hash, status, first_revision, last_revision, created_at, updated_at) VALUES (?, ?, ?, ?, 'active', ?, ?, ?, ?) ON CONFLICT(entry_id) DO UPDATE SET canonical_text=excluded.canonical_text, entry_hash=excluded.entry_hash, status='active', last_revision=excluded.last_revision, updated_at=excluded.updated_at",
			).run(entry.entryId, input.agentId, entry.text.trim(), entryHash, nextRevision, nextRevision, now, now);
			db.prepare(
				"INSERT INTO memory_head_revision_entries (agent_id, revision, entry_id, ordinal, operation, provenance_json) VALUES (?, ?, ?, ?, 'add', ?)",
			).run(input.agentId, nextRevision, entry.entryId, ordinal, JSON.stringify(entry.support));
		}
		db.prepare(
			"INSERT OR IGNORE INTO memory_md_heads (agent_id, content, content_hash, revision, updated_at) VALUES (?, '', '', 0, ?)",
		).run(input.agentId, now);
		db.prepare(
			"UPDATE memory_md_heads SET content=?, content_hash=?, revision=?, revision_id=?, pass_id=?, updated_at=? WHERE agent_id=?",
		).run(body, contentHash, nextRevision, revisionId, input.passId, now, input.agentId);
		const target = pathFor(input.agentId);
		mkdirSync(dirname(target), { recursive: true });
		const temporary = `${target}.curated-${revisionId}.tmp`;
		writeFileSync(temporary, `${body}\n`, "utf8");
		renameSync(temporary, target);
		return {
			ok: true,
			code: "COMMITTED",
			revision: nextRevision,
			hash: contentHash,
			changedIds: input.entries.map((entry) => entry.entryId),
		};
	});
}
