import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import {
	localAllReadScope,
	requireReadScope,
	attempt,
	type ReadScope,
	readScopeSql,
	redactCredentials,
} from "@signet/core";
import { prepareTypedStatement, type WriteDb } from "./db-accessor";
import { MEMORY_HEAD_MAX_TOKENS, type MemoryHeadCommitInput, type MemoryHeadRequest } from "./memory-head";
import { readEpisodicSource, sourceIdCandidates, type EpisodicSourceRecord } from "./episodic-sources";
import { dreamingPassPartitionInDb, dreamingReadScopeInDb, type DreamingPartition } from "./classification-owner";

import { renderDreamingEvidence } from "./pipeline/dreaming-evidence";
import { countTokens } from "./pipeline/tokenizer";
import { derivedScopeSql, evidenceScopeSql } from "./read-scope-tables";

const hash = (text: string): string => createHash("sha256").update(text).digest("hex");
const generatedMarker = /^<!-- (?:signet-generated-memory\b[^>]*|generated \d{4}-\d{2}-\d{2}[^>]*) -->\s*/;
const revisionMarker = /^<!-- signet-generated-memory agent=([a-z0-9-]+) revision=(\d+);/;
type Head = { revision: number; content: string; content_hash: string; revision_id: string | null; is_current: number };

export function renderMemoryHeadBody(entries: MemoryHeadCommitInput["entries"]): string {
	return entries.map((entry) => `- ${entry.text.trim()}`).join("\n");
}

export function memoryHeadInputError(input: MemoryHeadCommitInput): {
	readonly code: "INVALID_HEAD";
	readonly error: string;
	readonly tokens?: number;
	readonly maxTokens?: number;
} | null {
	if (
		input.entries.length > 200 ||
		Buffer.byteLength(JSON.stringify(input)) > 262144 ||
		input.entries.some((entry) => entry.support.length > 8)
	)
		return { code: "INVALID_HEAD", error: "head input exceeds its bounded budget" };
	const tokens = countTokens(renderMemoryHeadBody(input.entries));
	if (tokens <= MEMORY_HEAD_MAX_TOKENS) return null;
	return {
		code: "INVALID_HEAD",
		error: `head is ${tokens} tokens; it must be at most ${MEMORY_HEAD_MAX_TOKENS}. Shorten or drop entries and resubmit.`,
		tokens,
		maxTokens: MEMORY_HEAD_MAX_TOKENS,
	};
}

function currentSource(
	db: WriteDb,
	partition: DreamingPartition,
	from: string,
	callerScope?: ReadScope,
): EpisodicSourceRecord | null {
	const scope = callerScope ?? dreamingReadScopeInDb(db, partition.agentId, partition.compartmentId);
	const source = readEpisodicSource(db, { agentId: partition.agentId, from, readScope: scope });
	if (source?.completed !== true) return null;
	if (
		source.kind === "memory" &&
		!db
			.prepare(
				"SELECT 1 FROM memories WHERE id=? AND agent_id=? AND is_deleted=0 AND superseded_by IS NULL AND stale_at IS NULL AND visibility!='archived'",
			)
			.get(source.id, partition.agentId)
	)
		return null;
	return source;
}

function currentHead(db: WriteDb, partition: DreamingPartition): Head | undefined {
	const head =
		partition.compartmentId === null
			? prepareTypedStatement<Head>(
					db,
					"SELECT revision, content, content_hash, revision_id, is_current FROM memory_md_heads WHERE agent_id=?",
				).get(partition.agentId)
			: prepareTypedStatement<Head>(
					db,
					"SELECT revision, content, content_hash, id AS revision_id, is_current FROM memory_head_revisions WHERE agent_id=? AND compartment_id IS ? ORDER BY revision DESC LIMIT 1",
				).get(partition.agentId, partition.compartmentId);
	if (
		head?.revision_id &&
		db
			.prepare(
				"SELECT 1 FROM memory_head_revision_entries WHERE agent_id=? AND revision_id=? AND compartment_id IS NOT ? LIMIT 1",
			)
			.get(partition.agentId, head.revision_id, partition.compartmentId)
	)
		return { ...head, is_current: 0 };
	return head ?? undefined;
}

type ReadableHeadEntry = {
	readonly entry_id: string;
	readonly canonical_text: string;
	readonly compartment_id: number | null;
};

function readableHeadEntries(db: WriteDb, partition: DreamingPartition): readonly ReadableHeadEntry[] {
	const clause = readScopeSql("e", dreamingReadScopeInDb(db, partition.agentId, partition.compartmentId), {
		visibility: null,
	});
	return prepareTypedStatement<ReadableHeadEntry>(
		db,
		`SELECT e.entry_id, e.canonical_text, e.compartment_id FROM memory_head_entries e
		WHERE e.status='active' AND e.compartment_id IS NOT ? ${clause.sql}
		AND (e.compartment_id IS NULL AND EXISTS (
			SELECT 1 FROM memory_md_heads h WHERE h.agent_id=e.agent_id AND h.is_current=1 AND h.revision=e.last_revision
		) OR e.compartment_id IS NOT NULL AND EXISTS (
			SELECT 1 FROM memory_head_revisions r WHERE r.agent_id=e.agent_id AND r.compartment_id IS e.compartment_id
			AND r.revision=e.last_revision AND r.is_current=1 AND NOT EXISTS (
				SELECT 1 FROM memory_head_revisions newer WHERE newer.agent_id=r.agent_id AND newer.compartment_id IS r.compartment_id AND newer.revision>r.revision
			)
		)) ORDER BY e.compartment_id, e.entry_id LIMIT 200`,
	).all(partition.compartmentId, ...clause.args);
}

function knownProjection(db: WriteDb, content: string): boolean {
	const digest = hash(content.trim().replace(generatedMarker, "").trim());
	const marker = revisionMarker.exec(content.trim());
	if (marker) {
		const revision = prepareTypedStatement<{ content: string; content_hash: string }>(
			db,
			"SELECT content, content_hash FROM memory_head_revisions WHERE agent_id=? AND revision=? AND compartment_id IS NULL LIMIT 1",
		).get(marker[1], Number(marker[2]));
		return (
			revision != null && (revision.content_hash === digest || hash(redactCredentials(revision.content)) === digest)
		);
	}
	return (
		Boolean(
			db
				.prepare("SELECT 1 FROM memory_head_revisions WHERE content_hash=? AND compartment_id IS NULL LIMIT 1")
				.get(digest),
		) || Boolean(db.prepare("SELECT 1 FROM memory_md_heads WHERE content_hash=? LIMIT 1").get(digest))
	);
}
function isGenerated(db: WriteDb, content: string): boolean {
	if (knownProjection(db, content)) return true;
	const marker = revisionMarker.exec(content.trim());
	if (
		marker &&
		db
			.prepare("SELECT 1 FROM memory_head_revisions WHERE agent_id=? AND revision=? AND compartment_id IS NULL LIMIT 1")
			.get(marker[1], Number(marker[2]))
	)
		return false;
	return generatedMarker.test(content.trim());
}
function publish(db: WriteDb, root: string, agentId: string, head: Head): void {
	if (head.is_current !== 1) return;
	const target = agentId === "default" ? join(root, "MEMORY.md") : join(root, "agents", agentId, "MEMORY.md");
	let existing = "";
	if (existsSync(target)) {
		if (statSync(target).size > 262144)
			throw new Error("Existing MEMORY.md exceeds projection inspection budget; file preserved");
		existing = readFileSync(target, "utf8");
		if (!isGenerated(db, existing))
			throw new Error("User-authored MEMORY.md preserved; remove or move it to allow generated projection");
	}
	const projection = `<!-- signet-generated-memory agent=${agentId} revision=${head.revision}; inspect only, use Signet for current context -->\n\n${redactCredentials(head.content)}\n`;
	if ((head.content || existing) && existing !== projection) {
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
		"UPDATE memory_head_publications SET status='completed', completed_at=? WHERE agent_id=? AND revision=? AND compartment_id IS NULL",
	).run(new Date().toISOString(), agentId, head.revision);
}

const headEntryColumns = { memory: null, session: null, source: null } as const;

function readableHeadBody(
	db: WriteDb,
	agentId: string,
	revision: number,
	scope: ReadScope,
	dependencies?: Set<string>,
): string {
	const entry = derivedScopeSql("h", scope, headEntryColumns);
	const copy = derivedScopeSql("e", scope, headEntryColumns);
	const restricted = scope.compartments !== "all";
	const evidence: Evidence = new Map();
	const content = db
		.prepare(
			`SELECT h.canonical_text AS text, h.entry_id, e.provenance_json AS support
			 FROM memory_head_revision_entries e
			 JOIN memory_head_entries h ON h.agent_id = e.agent_id AND h.entry_id = e.entry_id
			 WHERE e.agent_id = ? AND ${restricted ? "e.revision = h.last_revision" : "e.revision = ?"} AND e.operation IN ('add','update','retain') AND h.status='active'${entry.sql}${copy.sql}
			 ORDER BY ${restricted ? "h.first_revision, e.ordinal, h.entry_id" : "e.ordinal"}`,
		)
		.all<Record<string, unknown>>(agentId, ...(restricted ? [] : [revision]), ...entry.args, ...copy.args)
		.flatMap((row) => {
			if (typeof row.text !== "string" || typeof row.entry_id !== "string") return [];
			if (restricted) {
				const rawSupport = row.support;
				const support: unknown = typeof rawSupport === "string" ? attempt(() => JSON.parse(rawSupport)) : null;
				if (!Array.isArray(support) || support.length === 0) return [];
				for (const item of support) {
					if (!isRecord(item)) continue;
					const reference =
						typeof item.source_ref === "string"
							? item.source_ref
							: typeof item.sourceRef === "string"
								? item.sourceRef
								: "";
					const separator = reference.indexOf(":");
					const kind = reference.slice(0, separator);
					if (!["memory", "artifact", "transcript", "summary"].includes(kind)) continue;
					for (const id of sourceIdCandidates(reference.slice(separator + 1)))
						dependencies?.add(JSON.stringify([kind, id, null]));
				}
				const entryId = row.entry_id;
				if (
					!support.every(
						(item: unknown) =>
							typeof item === "object" &&
							item !== null &&
							!Array.isArray(item) &&
							supportError(
								db,
								{ agentId, compartmentId: null },
								entryId,
								Object.fromEntries(Object.entries(item)),
								evidence,
								scope,
							) === null,
					)
				)
					return [];
			}
			return [`- ${row.text.trim()}`];
		})
		.join("\n");
	return content;
}

function authoredHeadReadable(db: WriteDb, agentId: string, scope: ReadScope): boolean {
	if (scope.projects !== null) return false;
	const labels = db
		.prepare(
			"SELECT classification_id FROM classification_assignments WHERE target_kind = 'agent' AND target_id = ? AND agent_id = ? ORDER BY classification_id",
		)
		.all<Record<string, unknown>>(agentId, agentId)
		.flatMap((row) => (typeof row.classification_id === "string" ? [row.classification_id] : []));
	const existing =
		labels.length === 0 ? null : db.prepare("SELECT id FROM compartments WHERE key = ?").get(labels.join(","));
	const label = labels.length === 0 ? null : typeof existing?.id === "number" ? existing.id : 0;
	const readable = evidenceScopeSql("authored", scope, headEntryColumns);
	return Boolean(
		db
			.prepare(
				`SELECT 1 AS readable FROM (SELECT ? AS agent_id, ? AS compartment_id) authored WHERE 1 = 1${readable.sql}`,
			)
			.get(agentId, label, ...readable.args),
	);
}

export function withContentPassWrites<T>(db: WriteDb, passId: string | undefined, write: () => T): T {
	if (passId === undefined) return write();
	const partition = dreamingPassPartitionInDb(db, passId);
	const pass = prepareTypedStatement<{ mode: string; head_base_revision: number | null }>(
		db,
		"SELECT mode, head_base_revision FROM dreaming_passes WHERE id=?",
	).get(passId);
	const before = currentHead(db, partition)?.revision ?? 0;
	const result = write();
	const after = currentHead(db, partition)?.revision ?? 0;
	if (pass?.mode === "incremental-content" && pass.head_base_revision === before)
		db.prepare("UPDATE dreaming_passes SET head_base_revision=? WHERE id=?").run(after, passId);
	return result;
}

export function commitCuratedMemoryHeadInDb(db: WriteDb, input: MemoryHeadCommitInput): Record<string, unknown> {
	const agentId = input.agentId;
	if (!/^[a-z0-9][a-z0-9-]*$/.test(agentId)) throw new Error("Invalid memory head agentId");
	const partition = dreamingPassPartitionInDb(db, input.passId, agentId);
	const pass = prepareTypedStatement<{ mode: string; head_base_revision: number | null }>(
		db,
		"SELECT mode, head_base_revision FROM dreaming_passes WHERE id=?",
	).get(input.passId);
	if (pass?.mode !== "incremental-content")
		return {
			ok: false,
			code: "PASS_NOT_AUTHORIZED",
			error: "only a running scoped content pass may commit the memory head",
		};
	const head = currentHead(db, partition);
	const revision = head?.revision ?? 0;
	const currentHash = head?.content_hash ?? "";
	if (pass.head_base_revision !== revision)
		return {
			ok: false,
			code: "STALE_HEAD",
			error: "evidence or head changed outside this content pass since it started",
			revision,
			hash: currentHash,
		};
	const invalid = memoryHeadInputError(input);
	if (invalid !== null) return { ok: false, ...invalid };
	const validated = validateEntries(db, input, partition);
	if (validated.error !== undefined) return validated.error;
	const body = renderMemoryHeadBody(input.entries);
	if (input.entries.length === 0 && (head?.content ?? "") === "")
		return { ok: true, code: "NOOP", revision, hash: currentHash, changed: false, changedIds: [] };
	if (input.entries.length === 0) {
		const carried = committedEntries(db, partition, head?.revision_id ?? null);
		if (carried.entries.length > 0 || carried.unverifiable)
			return {
				ok: false,
				code: "INVALID_HEAD",
				error:
					"committed entries still have valid or unverifiable support; resubmit or replace them instead of clearing the head",
			};
	}
	const contentHash = hash(body);
	if (head?.is_current === 1 && currentHash === contentHash)
		return { ok: true, code: "NOOP", revision, hash: contentHash, changed: false, changedIds: [] };
	const result = commitEntries(db, input, partition, validated.evidence, body, contentHash, revision, currentHash);
	if (result.ok) {
		const now = new Date().toISOString();
		const revisionId = String(result.revisionId);
		if (partition.compartmentId === null)
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
			"INSERT INTO memory_head_publications (agent_id, compartment_id, revision, revision_id, status, created_at, completed_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		).run(
			agentId,
			partition.compartmentId,
			revision + 1,
			revisionId,
			partition.compartmentId === null ? "pending" : "completed",
			now,
			partition.compartmentId === null ? null : now,
		);
	}
	return result;
}

export function executeMemoryHead(
	db: WriteDb,
	root: string,
	request: MemoryHeadRequest,
	dependencies?: Set<string>,
): Record<string, unknown> {
	if (!["read", "inspect", "commit", "publish"].includes(request.action))
		throw new Error("Unsupported memory head action");
	const agentId = request.action === "commit" ? request.input.agentId : request.agentId;
	if (!/^[a-z0-9][a-z0-9-]*$/.test(agentId)) throw new Error("Invalid memory head agentId");
	const passId =
		request.action === "commit" ? request.input.passId : request.action === "read" ? request.passId : undefined;
	const partition =
		passId === undefined ? { agentId, compartmentId: null } : dreamingPassPartitionInDb(db, passId, agentId);
	if (request.action === "commit") {
		const result = commitCuratedMemoryHeadInDb(db, request.input);
		if (result.ok === true && result.code === "COMMITTED" && partition.compartmentId === null) {
			const next = currentHead(db, partition);
			if (next == null) throw new Error("Committed head missing");
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
	const restrictedInspect = request.action === "inspect" && requireReadScope(request.readScope).compartments !== "all";
	const head =
		request.action === "inspect"
			? prepareTypedStatement<Head>(
					db,
					"SELECT revision, content, content_hash, revision_id, is_current FROM memory_md_heads WHERE agent_id=?",
				).get(agentId)
			: currentHead(db, partition);
	if (request.action === "inspect") {
		if (Buffer.byteLength(request.content) > 262144) throw new Error("Memory file exceeds inspection budget");
		const generated =
			!request.content.trim() ||
			(restrictedInspect && generatedMarker.test(request.content.trim())) ||
			isGenerated(db, request.content);
		const scope = request.readScope;
		if (!generated)
			return {
				generated,
				status: "authored",
				content: authoredHeadReadable(db, agentId, scope) ? request.content : null,
			};
		if (scope.compartments !== "all" && head && head.revision > 0) {
			const content = readableHeadBody(db, agentId, head.revision, scope, dependencies);
			return scope.projects === null && !content && head.content
				? { generated, status: "stale", content: null }
				: { generated, status: "current", content };
		}
		if (head?.is_current !== 1) return { generated, status: "stale", content: null };
		return {
			generated,
			status: "current",
			content: readableHeadBody(db, agentId, head.revision, scope, dependencies),
		};
	}
	const publicationPending =
		head?.is_current === 1 &&
		partition.compartmentId === null &&
		Boolean(
			db
				.prepare(
					"SELECT 1 FROM memory_head_publications WHERE agent_id=? AND revision=? AND compartment_id IS NULL AND status='pending' LIMIT 1",
				)
				.get(agentId, head.revision),
		);
	if (request.action === "publish") {
		if (publicationPending && head !== undefined) {
			try {
				publish(db, root, agentId, head);
			} catch (error) {
				return {
					ok: false,
					publication: "pending",
					publicationError: error instanceof Error ? error.message : String(error),
				};
			}
		}
		return { ok: true, publication: head?.is_current === 1 ? "completed" : "stale" };
	}
	const committed = passId === undefined ? null : committedEntries(db, partition, head?.revision_id ?? null).entries;
	return {
		agentId,
		compartmentId: partition.compartmentId,
		...(publicationPending ? { publication: "pending" } : {}),
		revision: head?.revision ?? 0,
		hash: head?.content_hash ?? "",
		revisionId: head?.revision_id ?? null,
		content: head?.is_current === 1 ? head.content : null,
		status: head?.is_current === 1 ? "current" : "stale",
		entries:
			head?.is_current === 1
				? db
						.prepare(
							"SELECT entry_id, canonical_text, status FROM memory_head_entries WHERE agent_id=? AND compartment_id IS ? AND status='active' AND last_revision=? ORDER BY entry_id",
						)
						.all(agentId, partition.compartmentId, head.revision)
				: [],
		readableEntries: passId === undefined ? [] : readableHeadEntries(db, partition),
		maxTokens: MEMORY_HEAD_MAX_TOKENS,
		tokens: head?.is_current === 1 ? countTokens(head.content) : 0,
		...(committed === null
			? {}
			: { committedEntries: committed, committedTokens: countTokens(renderMemoryHeadBody(committed)) }),
	};
}

type Evidence = Map<string, { readonly source: EpisodicSourceRecord; readonly rendered: string } | null>;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function committedEntries(
	db: WriteDb,
	partition: DreamingPartition,
	revisionId: string | null,
	evidence: Evidence = new Map(),
): { entries: MemoryHeadCommitInput["entries"]; unverifiable: boolean } {
	if (revisionId === null) return { entries: [], unverifiable: false };
	const rows = prepareTypedStatement<{ entryId: string; text: string; support: string }>(
		db,
		`SELECT e.entry_id AS entryId, h.canonical_text AS text, e.provenance_json AS support
			 FROM memory_head_revisions r
			 JOIN memory_head_revision_entries e ON e.agent_id = r.agent_id AND e.revision_id = r.id AND e.compartment_id IS r.compartment_id AND e.operation = 'add'
			 JOIN memory_head_entries h ON h.agent_id = e.agent_id AND h.entry_id = e.entry_id
			 WHERE r.id = ? AND r.agent_id = ? AND r.compartment_id IS ? AND h.compartment_id IS ? ORDER BY e.ordinal`,
	).all(revisionId, partition.agentId, partition.compartmentId, partition.compartmentId);
	const entries: MemoryHeadCommitInput["entries"][number][] = [];
	let unverifiable = false;
	for (const row of rows) {
		const parsed: unknown = attempt(() => JSON.parse(row.support));
		if (!Array.isArray(parsed) || !parsed.every(isRecord)) {
			unverifiable = true;
			continue;
		}
		const support = parsed.filter((item) => supportError(db, partition, row.entryId, item, evidence) === null);
		if (support.length > 0) entries.push({ entryId: row.entryId, text: row.text, support });
	}
	return { entries, unverifiable };
}

function supportError(
	db: WriteDb,
	partition: DreamingPartition,
	entryId: string,
	support: Record<string, unknown>,
	evidence: Evidence,
	readScope?: ReadScope,
): { code: string; error: string } | null {
	const sourceRef =
		typeof support.source_ref === "string"
			? support.source_ref
			: typeof support.sourceRef === "string"
				? support.sourceRef
				: "";
	const quote = typeof support.quote === "string" ? support.quote.trim() : "";
	if (!quote || sourceRef.startsWith("attention:") || !/^(memory|artifact|transcript|summary):.+$/.test(sourceRef))
		return { code: "INVALID_PROVENANCE", error: `entry ${entryId} requires scoped exact evidence` };
	let rendered = evidence.get(sourceRef);
	if (rendered === undefined) {
		const source = currentSource(db, partition, sourceRef, readScope);
		rendered = source === null ? null : { source, rendered: renderDreamingEvidence(source) };
		evidence.set(sourceRef, rendered);
	}
	if (rendered === null || !rendered.rendered.includes(quote))
		return { code: "INVALID_PROVENANCE", error: `entry ${entryId} quote is not exact scoped evidence` };
	return null;
}

function validateEntries(
	db: WriteDb,
	input: MemoryHeadCommitInput,
	partition: DreamingPartition,
): { evidence: Evidence; error?: undefined } | { error: Record<string, unknown> } {
	const evidence: Evidence = new Map();
	const ids = new Set<string>();
	for (const entry of input.entries) {
		if (ids.has(entry.entryId)) return { error: { ok: false, code: "INVALID_HEAD", error: "duplicate entry id" } };
		ids.add(entry.entryId);
		if (entry.support.length === 0)
			return { error: { ok: false, code: "MISSING_PROVENANCE", error: `entry ${entry.entryId} has no evidence` } };
		for (const support of entry.support) {
			const invalid = supportError(db, partition, entry.entryId, support, evidence);
			if (invalid !== null) return { error: { ok: false, ...invalid } };
		}
	}
	return { evidence };
}

function commitEntries(
	db: WriteDb,
	input: MemoryHeadCommitInput,
	partition: DreamingPartition,
	evidence: Evidence,
	body: string,
	contentHash: string,
	revision: number,
	currentHash: string,
): Record<string, unknown> {
	const nextRevision = revision + 1;
	const revisionId = randomUUID();
	const now = new Date().toISOString();
	db.prepare(
		"INSERT INTO memory_head_revisions (id, agent_id, revision, content, content_hash, rendered_token_count, pass_id, base_revision, base_hash, created_at, compartment_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
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
		partition.compartmentId,
	);
	db.prepare("UPDATE memory_head_revisions SET is_current=0 WHERE agent_id=? AND compartment_id IS ? AND id!=?").run(
		input.agentId,
		partition.compartmentId,
		revisionId,
	);
	for (const [ordinal, entry] of input.entries.entries()) {
		const revisionCitationId = JSON.stringify([revisionId, entry.entryId]);
		const entryHash = hash(entry.text.trim());
		db.prepare(
			"INSERT INTO memory_head_entries (id, entry_id, agent_id, canonical_text, entry_hash, status, first_revision, last_revision, created_at, updated_at, compartment_id, pass_id) VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?, ?) ON CONFLICT(agent_id, entry_id, COALESCE(compartment_id,0)) DO UPDATE SET canonical_text=excluded.canonical_text, entry_hash=excluded.entry_hash, status='active', last_revision=excluded.last_revision, updated_at=excluded.updated_at, pass_id=excluded.pass_id",
		).run(
			randomUUID(),
			entry.entryId,
			input.agentId,
			entry.text.trim(),
			entryHash,
			nextRevision,
			nextRevision,
			now,
			now,
			partition.compartmentId,
			input.passId,
		);
		const storedEntry = prepareTypedStatement<{ id: string }>(
			db,
			"SELECT id FROM memory_head_entries WHERE agent_id=? AND entry_id=? AND compartment_id IS ?",
		).get(input.agentId, entry.entryId, partition.compartmentId);
		if (!storedEntry) throw new Error("Committed head entry missing");
		const entryCitationId = storedEntry.id;
		db.prepare(
			"INSERT INTO memory_head_revision_entries (agent_id, revision, entry_id, ordinal, operation, provenance_json, compartment_id, pass_id, revision_id) VALUES (?, ?, ?, ?, 'add', ?, ?, ?, ?)",
		).run(
			input.agentId,
			nextRevision,
			entry.entryId,
			ordinal,
			JSON.stringify(entry.support),
			partition.compartmentId,
			input.passId,
			revisionId,
		);
		db.prepare(
			"INSERT INTO evidence_citations(derived_kind,derived_id,agent_id,evidence_kind,evidence_id) VALUES('head_revision',?,?,'attribute',?)",
		).run(revisionCitationId, input.agentId, entryCitationId);
		db.prepare("DELETE FROM evidence_citations WHERE derived_kind='head_entry' AND derived_id=? AND agent_id=?").run(
			entryCitationId,
			input.agentId,
		);
		for (const support of entry.support) {
			const ref =
				typeof support.source_ref === "string"
					? support.source_ref
					: typeof support.sourceRef === "string"
						? support.sourceRef
						: "";
			const citation = evidence.get(ref);
			if (citation === undefined || citation === null) throw new Error("Validated evidence missing");
			for (const [kind, id] of [
				["head_entry", entryCitationId],
				["head_revision", revisionCitationId],
			])
				db.prepare(
					"INSERT OR IGNORE INTO evidence_citations(derived_kind,derived_id,agent_id,evidence_kind,evidence_id) VALUES(?,?,?,?,?)",
				).run(kind, id, input.agentId, citation.source.kind, citation.source.id);
		}
	}
	const activeEntries = prepareTypedStatement<{ entry_id: string }>(
		db,
		"SELECT entry_id FROM memory_head_entries WHERE agent_id = ? AND compartment_id IS ? AND status = 'active'",
	).all(input.agentId, partition.compartmentId);
	const retained = new Set(input.entries.map((entry) => entry.entryId));
	let ordinal = input.entries.length;
	for (const old of activeEntries) {
		if (retained.has(old.entry_id)) continue;
		db.prepare(
			"UPDATE memory_head_entries SET status='removed', last_revision=?, updated_at=? WHERE agent_id=? AND entry_id=? AND compartment_id IS ?",
		).run(nextRevision, now, input.agentId, old.entry_id, partition.compartmentId);
		db.prepare(
			"INSERT INTO memory_head_revision_entries (agent_id, revision, entry_id, ordinal, operation, provenance_json, compartment_id, pass_id, revision_id) VALUES (?, ?, ?, ?, 'remove', '[]', ?, ?, ?)",
		).run(input.agentId, nextRevision, old.entry_id, ordinal++, partition.compartmentId, input.passId, revisionId);
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
