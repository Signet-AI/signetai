import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { scanMemoryContent } from "@signet/core";
import type { WriteDb } from "./db-accessor";
import type { MemoryHeadCuration, MemoryHeadRequest } from "./memory-head";
import { readEpisodicSource } from "./episodic-sources";
import { renderDreamingEvidence } from "./pipeline/dreaming-evidence";
import { countTokens } from "./pipeline/tokenizer";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const generatedMarker = /^<!-- (?:signet-generated-memory\b[^>]*|generated \d{4}-\d{2}-\d{2}[^>]*) -->\s*/;
const revisionMarker = /^<!-- signet-generated-memory agent=([a-z0-9-]+) revision=(\d+);/;
type Head = { revision: number; content: string; content_hash: string; revision_id: string | null; is_current: number };

function currentSource(db: WriteDb, agentId: string, from: string) {
	from = from.replace(/^source:/, "artifact:").replace(/^session:/, "transcript:");
	if (!/^(memory|artifact|transcript|summary):.+$/.test(from)) return null;
	if (
		from.startsWith("memory:") &&
		!db
			.prepare(
				"SELECT 1 FROM memories WHERE id=? AND agent_id=? AND is_deleted=0 AND superseded_by IS NULL AND stale_at IS NULL AND visibility != 'archived'",
			)
			.get(from.slice(7), agentId)
	)
		return null;
	const source = readEpisodicSource(db, { agentId, from });
	return source?.completed === true ? source : null;
}

function knownProjection(db: WriteDb, content: string): boolean {
	const digest = hash(content.trim().replace(generatedMarker, "").trim());
	const marker = revisionMarker.exec(content.trim());
	if (marker)
		return Boolean(
			db
				.prepare("SELECT 1 FROM memory_head_revisions WHERE agent_id=? AND revision=? AND content_hash=? LIMIT 1")
				.get(marker[1], Number(marker[2]), digest),
		);
	return (
		Boolean(db.prepare("SELECT 1 FROM memory_head_revisions WHERE content_hash=? LIMIT 1").get(digest)) ||
		Boolean(db.prepare("SELECT 1 FROM memory_md_heads WHERE content_hash=? LIMIT 1").get(digest))
	);
}
function isGenerated(db: WriteDb, content: string): boolean {
	if (knownProjection(db, content)) return true;
	const marker = revisionMarker.exec(content.trim());
	// An edit to a known published revision becomes authored text. Unknown legacy
	// markers remain unverified snapshots, including files left by an aborted commit.
	if (
		marker &&
		db
			.prepare("SELECT 1 FROM memory_head_revisions WHERE agent_id=? AND revision=? LIMIT 1")
			.get(marker[1], Number(marker[2]))
	)
		return false;
	return generatedMarker.test(content.trim());
}

/** Called only inside the owner's transaction. Files are projections, never read as the head. */
function publish(db: WriteDb, root: string, agentId: string, head: Head): void {
	if (head.is_current !== 1 || !head.content) return;
	const target = agentId === "default" ? join(root, "MEMORY.md") : join(root, "agents", agentId, "MEMORY.md");
	// A user edit takes custody of the file. Do not read an unbounded authored file.
	let existing = "";
	if (existsSync(target)) {
		if (statSync(target).size > 262144)
			throw new Error("Existing MEMORY.md exceeds projection inspection budget; file preserved");
		existing = readFileSync(target, "utf8");
		if (!isGenerated(db, existing))
			throw new Error("User-authored MEMORY.md preserved; remove or move it to allow generated projection");
	}
	const projection = `<!-- signet-generated-memory agent=${agentId} revision=${head.revision}; inspect only, use Signet for current context -->\n\n${head.content}\n`;
	if (existing !== projection) {
		mkdirSync(dirname(target), { recursive: true });
		const temporary = `${target}.head-${head.revision}.tmp`;
		try {
			writeFileSync(temporary, projection, "utf8");
			renameSync(temporary, target);
		} finally {
			rmSync(temporary, { force: true });
		}
	}

	db.prepare(
		"UPDATE memory_head_publications SET status='completed', completed_at=? WHERE agent_id=? AND revision=?",
	).run(new Date().toISOString(), agentId, head.revision);
}

export function executeMemoryHead(db: WriteDb, root: string, request: MemoryHeadRequest): Record<string, unknown> {
	const agentId = request.action === "commit" || request.action === "curate" ? request.input.agentId : request.agentId;
	if (!/^[a-z0-9][a-z0-9-]*$/.test(agentId)) throw new Error("Invalid memory head agentId");
	const head = db
		.prepare("SELECT revision, content, content_hash, revision_id, is_current FROM memory_md_heads WHERE agent_id=?")
		.get(agentId) as Head | undefined;
	if (request.action === "inspect") {
		if (Buffer.byteLength(request.content) > 262144) throw new Error("Memory file exceeds inspection budget");
		const generated = !request.content.trim() || isGenerated(db, request.content);
		return {
			generated,
			status: generated ? (head?.is_current === 1 ? "current" : "stale") : "authored",
			content: generated ? (head?.is_current === 1 ? head.content : null) : request.content,
		};
	}
	if (request.action === "read") {
		let publicationError: string | undefined;
		if (head?.is_current === 1) {
			try {
				publish(db, root, agentId, head);
			} catch (error) {
				publicationError = String(error);
			}
		}
		return {
			agentId,
			...(publicationError ? { publication: "pending", publicationError } : {}),
			revision: head?.revision ?? 0,
			hash: head?.content_hash ?? "",
			revisionId: head?.revision_id ?? null,
			status: head?.is_current === 1 ? "current" : "stale",
			entries:
				head?.is_current === 1
					? db
							.prepare(
								"SELECT entry_id, canonical_text, status FROM memory_head_entries WHERE agent_id=? AND status='active' ORDER BY entry_id",
							)
							.all(agentId)
					: [],
		};
	}
	const input = request.input;
	const pass = db
		.prepare("SELECT status, mode, agent_id, head_base_revision FROM dreaming_passes WHERE id=?")
		.get(input.passId) as
		| { status: string; mode: string; agent_id: string; head_base_revision: number | null }
		| undefined;
	if (pass?.status !== "running" || pass.mode !== "incremental-content" || pass.agent_id !== agentId)
		return {
			ok: false,
			code: "PASS_NOT_AUTHORIZED",
			error: "only a running scoped content pass may commit the memory head",
		};
	const revision = head?.revision ?? 0;
	const currentHash = head?.content_hash ?? "";
	if (input.baseRevision !== revision || input.baseHash !== currentHash || pass.head_base_revision !== revision)
		return {
			ok: false,
			code: "STALE_HEAD",
			error: "evidence or head changed since the content pass started",
			revision,
			hash: currentHash,
		};
	if (
		input.entries.length > 200 ||
		Buffer.byteLength(JSON.stringify(input)) > 262144 ||
		(request.action === "commit"
			? request.input.entries.some((entry) => entry.support.length > 8)
			: request.input.entries.some((entry) => entry.sourceRefs.length > 8 || entry.supportingQuotes.length > 8))
	)
		return { ok: false, code: "INVALID_HEAD", error: "head input exceeds its bounded budget" };
	const body =
		request.action === "curate"
			? request.input.content.trim()
			: request.input.entries.map((entry) => `- ${entry.text.trim()}`).join("\n");
	const safety = scanMemoryContent(body);
	if (!body || !safety.contextEligible || countTokens(body) > 1000)
		return { ok: false, code: "INVALID_HEAD", error: "head must be nonempty, safe, and at most 1000 tokens" };
	const contentHash = hash(body);
	// Re-validating unchanged text after invalidation is a new publication, not a no-op.
	if (head?.is_current === 1 && currentHash === contentHash)
		return { ok: true, code: "NOOP", revision, hash: contentHash, changed: false, changedIds: [] };
	const result =
		request.action === "curate"
			? commitLegacy(db, request.input, body, contentHash, revision, currentHash)
			: commitEntries(db, request.input, body, contentHash, revision, currentHash);
	if (result.ok) {
		const now = new Date().toISOString();
		const revisionId = String(result.revisionId);
		db.prepare(
			"UPDATE memory_md_heads SET content=?, content_hash=?, revision=?, revision_id=?, pass_id=?, updated_at=?, is_current=1, lease_token=NULL, lease_owner=NULL, lease_expires_at=NULL WHERE agent_id=?",
		).run(body, contentHash, revision + 1, revisionId, input.passId, now, agentId);
		db.prepare("UPDATE dreaming_passes SET head_revision=?, head_hash=? WHERE id=? AND agent_id=?").run(
			revision + 1,
			contentHash,
			input.passId,
			agentId,
		);
		db.prepare(
			"INSERT INTO memory_head_publications (agent_id, revision, revision_id, status, created_at) VALUES (?, ?, ?, 'pending', ?)",
		).run(agentId, revision + 1, revisionId, now);

		const next = db
			.prepare("SELECT revision, content, content_hash, revision_id, is_current FROM memory_md_heads WHERE agent_id=?")
			.get(agentId) as Head;
		try {
			publish(db, root, agentId, next);
		} catch (error) {
			return {
				...result,
				ok: false,
				code: "PUBLICATION_PENDING",
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}
	return result;
}

function commitEntries(
	db: WriteDb,
	input: Extract<MemoryHeadRequest, { action: "commit" }>["input"],
	body: string,
	contentHash: string,
	revision: number,
	currentHash: string,
): Record<string, unknown> {
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
			if (!quote || sourceRef.startsWith("attention:") || !/^(memory|artifact|transcript|summary):.+$/.test(sourceRef))
				return {
					ok: false,
					code: "INVALID_PROVENANCE",
					error: `entry ${entry.entryId} requires scoped exact evidence`,
				};
			const source = currentSource(db, input.agentId, sourceRef);
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

	return {
		ok: true,
		code: "COMMITTED",
		revisionId,
		revision: nextRevision,
		hash: contentHash,
		changedIds: input.entries.map((entry) => entry.entryId),
	};
}

function commitLegacy(
	db: WriteDb,
	input: MemoryHeadCuration,
	body: string,
	contentHash: string,
	revision: number,
	currentHash: string,
): Record<string, unknown> {
	for (const entry of input.entries) {
		if (!entry.id.trim() || !entry.text.trim())
			return { ok: false, code: "INVALID_HEAD", error: "entries require id and text" };
		if (entry.operation === "deferred" || entry.operation === "no-op") continue;
		if (!entry.sourceRefs.length || !entry.supportingQuotes.length)
			return { ok: false, code: "INVALID_PROVENANCE", error: "entries require evidence" };
		const sources = entry.sourceRefs.map((ref) => currentSource(db, input.agentId, ref));
		if (
			sources.some((source) => source === null) ||
			entry.supportingQuotes.some(
				(quote) =>
					!quote.trim() ||
					!sources.some((source) => source !== null && renderDreamingEvidence(source).includes(quote.trim())),
			)
		)
			return { ok: false, code: "INVALID_PROVENANCE", error: "quotes must be current scoped evidence" };
	}
	const next = revision + 1;
	const now = new Date().toISOString();
	const revisionId = randomUUID();
	// Keep the legacy operation audit format; both inputs use the same fence/publication.
	for (const [index, entry] of input.entries.entries())
		db.prepare(
			"INSERT INTO memory_head_revisions (id, agent_id, revision, content, content_hash, rendered_token_count, pass_id, base_revision, base_hash, created_at, entry_id, entry_text, operation, source_refs_json, supporting_quotes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
		).run(
			index === 0 ? revisionId : randomUUID(),
			input.agentId,
			next,
			body,
			contentHash,
			countTokens(body),
			input.passId,
			revision,
			currentHash,
			now,
			entry.id,
			entry.text,
			entry.operation,
			JSON.stringify(entry.sourceRefs),
			JSON.stringify(entry.supportingQuotes),
		);
	if (!input.entries.length) return { ok: false, code: "INVALID_PROVENANCE", error: "head requires audit entries" };

	db.prepare(
		"UPDATE dreaming_passes SET head_added=?, head_updated=?, head_removed=?, head_deferred=?, head_no_op=? WHERE id=? AND agent_id=?",
	).run(
		...["added", "updated", "removed", "deferred", "no-op"].map(
			(op) => input.entries.filter((entry) => entry.operation === op).length,
		),
		input.passId,
		input.agentId,
	);

	return { ok: true, revision: next, revisionId, hash: contentHash, changed: true };
}
