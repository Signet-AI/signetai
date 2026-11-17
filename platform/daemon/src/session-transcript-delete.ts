import { dirname, resolve } from "node:path";
import { constants } from "node:fs";
import { mkdir, readdir } from "node:fs/promises";
import { resolveWorkspaceLayout } from "@signet/core";
import { parseFrontmatterDocument } from "./memory-lineage";
import { logger } from "./logger";
import { type WriteDb, prepareTypedStatement } from "./db-accessor";
import { redactSessionTranscriptUploadBatchInTx } from "./transcript-import-bytes-owner";
import { txDeleteMemoryEmbeddings, txForgetMemory, txPurgeMemory } from "./transactions";
import { transcriptDeletionFencePath } from "./transcript-deletion-fence";
import { openContainedTranscriptFile, removeContainedTranscriptPath } from "./transcript-import-safe-fs";
import { removeCanonicalTranscriptSession } from "./transcript-jsonl";

export interface SessionTranscriptDeleteInput {
	readonly basePath: string;
	readonly sessionKey: string;
	readonly agentId: string;
	readonly project?: string;
	readonly hard: boolean;
	readonly changedBy: string;
	readonly active: boolean;
}

export type SessionTranscriptDeleteResult =
	| { readonly status: "not_found" }
	| { readonly status: "forbidden" }
	| {
			readonly status: "deleted";
			readonly sessionKey: string;
			readonly agentId: string;
			readonly hard: boolean;
			readonly counts: Readonly<Record<string, number>>;
			readonly pendingCleanup: readonly string[];
	  };

type Transact = <T>(operation: () => T) => T;

export async function deleteSessionTranscript(
	db: WriteDb,
	input: SessionTranscriptDeleteInput,
	transact: Transact,
): Promise<SessionTranscriptDeleteResult> {
	const deadline = Date.now() + 45_000;
	const counts: Record<string, number> = {};
	const add = (key: string, count: number): void => {
		counts[key] = (counts[key] ?? 0) + count;
	};
	const initial = (():
		| { status: "not_found" }
		| { status: "forbidden" }
		| {
				status: "ready";
				hard: boolean;
				harness: string | null;
				project: string | null;
				targets: string;
				paths: string[];
		  } => {
		const previous = prepareTypedStatement<{
			harness: string | null;
			project: string | null;
			hard: number;
			targets: string;
		}>(
			db,
			"SELECT harness,project,hard,targets FROM session_transcript_deletions WHERE agent_id = ? AND session_key = ?",
		).get(input.agentId, input.sessionKey);
		const stored = prepareTypedStatement<{ harness: string | null; project: string | null }>(
			db,
			"SELECT harness,project FROM session_transcripts WHERE agent_id = ? AND session_key = ?",
		).get(input.agentId, input.sessionKey);
		const owner = previous ?? stored;
		if (!owner && !input.active) return { status: "not_found" };
		if (previous?.hard === 1 && !input.hard) return { status: "forbidden" };
		if (input.project !== undefined && owner?.project !== input.project) return { status: "forbidden" };
		const targets =
			previous?.targets ??
			JSON.stringify(
				prepareTypedStatement<{ source_path: string }>(
					db,
					"SELECT source_path FROM memory_artifacts WHERE agent_id = ? AND session_key = ? LIMIT 10001",
				)
					.all(input.agentId, input.sessionKey)
					.map((row) => row.source_path),
			);
		const paths: unknown = JSON.parse(targets);
		if (!Array.isArray(paths) || !paths.every((path): path is string => typeof path === "string"))
			throw new Error("Invalid cleanup targets");
		if (paths.length > 10_000 || targets.length > 1_000_000)
			throw new Error("Transcript artifact cleanup admission limit");
		return {
			status: "ready",
			hard: input.hard,
			harness: owner?.harness ?? null,
			project: owner?.project ?? null,
			targets,
			paths,
		};
	})();
	if (initial.status === "not_found") return { status: "not_found" };
	if (initial.status === "forbidden") return { status: "forbidden" };
	const pending: string[] = [];
	const incomplete = (stage: string, error: unknown): void => {
		pending.push(stage);
		logger.warn("transcripts", "Session transcript cleanup incomplete", {
			agentId: input.agentId,
			sessionKey: input.sessionKey,
			stage,
			error: error instanceof Error ? error.message : String(error),
		});
	};
	{
		const fence = transcriptDeletionFencePath(input);
		await mkdir(dirname(fence), { recursive: true });
		const handle = await openContainedTranscriptFile(
			input.basePath,
			fence,
			constants.O_WRONLY | constants.O_CREAT | constants.O_APPEND,
			0o600,
		);
		try {
			await handle.sync();
		} finally {
			await handle.close();
		}
		const directory = await openContainedTranscriptFile(
			input.basePath,
			dirname(fence),
			constants.O_RDONLY | constants.O_DIRECTORY,
		);
		try {
			await directory.sync();
		} finally {
			await directory.close();
		}
	}
	transact(() => {
		db.prepare(
			"INSERT INTO session_transcript_deletions (agent_id,session_key,harness,project,hard,requested_at,targets) VALUES (?,?,?,?,?,datetime('now'),?) ON CONFLICT(agent_id,session_key) DO UPDATE SET hard = MAX(hard,excluded.hard), completed_at = NULL",
		).run(input.agentId, input.sessionKey, initial.harness, initial.project, Number(initial.hard), initial.targets);
		add(
			"transcripts",
			db
				.prepare("DELETE FROM session_transcripts WHERE agent_id = ? AND session_key = ? RETURNING session_key")
				.all(input.agentId, input.sessionKey).length,
		);
		add(
			"cursors",
			db
				.prepare("DELETE FROM session_extract_cursors WHERE agent_id = ? AND session_key = ? RETURNING session_key")
				.all(input.agentId, input.sessionKey).length,
		);
		db.prepare(
			"UPDATE transcript_import_conversations SET state = 'removed', updated_at = datetime('now') WHERE agent_id = ? AND canonical_key = ?",
		).run(input.agentId, input.sessionKey);
	});
	try {
		for (;;) {
			if (Date.now() >= deadline) throw new Error("deadline");
			const batch = transact(() => {
				const rows: Record<string, number> = {};
				const changed = purgeTranscriptBatch(db, input, initial.hard === true, (key, count) => {
					rows[key] = (rows[key] ?? 0) + count;
				});
				return { changed, rows };
			});
			for (const [key, count] of Object.entries(batch.rows)) add(key, count);
			if (!batch.changed) break;
			await new Promise<void>((resolve) => setImmediate(resolve));
		}
	} catch (error) {
		incomplete("derived_state", error);
	}
	try {
		const targets = initial.paths;
		const layout = resolveWorkspaceLayout(input.basePath);
		const roots = new Set([
			layout.transcripts,
			resolve(input.basePath, "memory"),
			resolve(input.basePath, "transcripts"),
			resolve(layout.runtime, "logs", "transcripts"),
		]);
		const paths = new Set(targets.map((path) => resolve(input.basePath, path)));
		for (const root of roots) await collectFiles(root, paths, deadline);
		for (const path of paths) {
			if (Date.now() >= deadline) throw new Error("deadline");
			if (
				path.endsWith(".jsonl") ||
				path.endsWith(".json") ||
				path.endsWith(".tmp") ||
				path.endsWith(".snapshot-tmp") ||
				path.endsWith(".rewrite-tmp")
			) {
				add("records", await removeCanonicalTranscriptSession(path, input, deadline));
				continue;
			}
			if (!path.endsWith(".md")) continue;
			if (!targets.some((target) => resolve(input.basePath, target) === path)) {
				const handle = await openContainedTranscriptFile(input.basePath, path, constants.O_RDONLY);
				try {
					const buffer = new Uint8Array(8192);
					const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
					const metadata = parseFrontmatterDocument(
						new TextDecoder().decode(buffer.subarray(0, bytesRead)),
					).frontmatter;
					if (
						metadata.agent_id !== input.agentId ||
						metadata.session_key !== input.sessionKey ||
						!["transcript", "summary", "compaction", "manifest"].includes(String(metadata.kind))
					)
						continue;
				} finally {
					await handle.close();
				}
			}
			await removeContainedTranscriptPath(input.basePath, path, { force: true });
			add("filePathsCleaned", 1);
		}
	} catch (error) {
		incomplete("transcript_bytes", error);
	}
	if (pending.length === 0)
		transact(() => {
			db.prepare(
				"UPDATE session_transcript_deletions SET completed_at = datetime('now') WHERE agent_id = ? AND session_key = ?",
			).run(input.agentId, input.sessionKey);
		});
	return {
		status: "deleted",
		sessionKey: input.sessionKey,
		agentId: input.agentId,
		hard: initial.hard === true,
		counts,
		pendingCleanup: pending,
	};
}

function purgeTranscriptBatch(
	db: WriteDb,
	input: SessionTranscriptDeleteInput,
	hard: boolean,
	add: (key: string, count: number) => void,
): number {
	const captures = db
		.prepare(
			"DELETE FROM transcript_capture_jobs WHERE id IN (SELECT id FROM transcript_capture_jobs WHERE agent_id = ? AND session_key = ? LIMIT 100) RETURNING id",
		)
		.all(input.agentId, input.sessionKey).length;
	if (captures) {
		add("captureJobs", captures);
		return captures;
	}
	const bytes = redactSessionTranscriptUploadBatchInTx(db, input.agentId, input.sessionKey);
	if (bytes) {
		if (bytes > 0) add("uploadedBytes", bytes);
		return 1;
	}
	const summaries = `WITH RECURSIVE affected(id) AS (
		SELECT id FROM session_summaries WHERE agent_id = ? AND session_key = ?
		UNION SELECT c.parent_id FROM session_summary_children c JOIN affected a ON a.id = c.child_id JOIN session_summaries s ON s.id = c.parent_id WHERE s.agent_id = ?)
		SELECT id FROM affected`;
	const params = [input.agentId, input.sessionKey, input.agentId];
	const ids = prepareTypedStatement<{ id: string }>(
		db,
		`SELECT id FROM memories m WHERE m.agent_id = ? AND ${hard ? "1" : "COALESCE(m.is_deleted,0) = 0"} AND (
		(source_id = ? AND (type = 'session_summary' OR source_type IN ('transcript','session','session_summary','checkpoint',(SELECT harness FROM session_transcript_deletions WHERE agent_id = ? AND session_key = ?))))
		OR id IN (SELECT memory_id FROM session_transcript_deleted_memories WHERE agent_id = ? AND session_key = ?)
		OR id IN (SELECT derived_memory_id FROM derived_memory_sources WHERE agent_id = ? AND ((source_kind = 'transcript' AND source_id = ?) OR (source_kind = 'summary' AND source_id IN (${summaries})) OR (source_kind = 'memory' AND source_id IN (SELECT memory_id FROM session_transcript_deleted_memories WHERE agent_id = ? AND session_key = ?))))) LIMIT 100`,
	).all(
		input.agentId,
		input.sessionKey,
		input.agentId,
		input.sessionKey,
		input.agentId,
		input.sessionKey,
		input.agentId,
		input.sessionKey,
		...params,
		input.agentId,
		input.sessionKey,
	);
	for (const row of ids) {
		db.prepare(
			"INSERT OR IGNORE INTO session_transcript_deleted_memories (agent_id,session_key,memory_id) VALUES (?,?,?)",
		).run(input.agentId, input.sessionKey, row.id);
		const mutation = {
			memoryId: row.id,
			reason: "session transcript deleted",
			force: true,
			changedBy: input.changedBy,
			changedAt: new Date().toISOString(),
			ctx: { actorType: "operator" },
		};
		if (hard) txPurgeMemory(db, mutation);
		if (!hard) {
			txForgetMemory(db, mutation);
			add("embeddings", txDeleteMemoryEmbeddings(db, row.id));
			db.prepare(
				"UPDATE entity_attributes SET status = 'archived', archived_at = datetime('now'), archive_reason = 'session transcript deleted' WHERE agent_id = ? AND memory_id = ?",
			).run(input.agentId, row.id);
		}
		add("memories", 1);
	}
	if (ids.length) return ids.length;
	const nodes = prepareTypedStatement<{ id: string }>(
		db,
		`${summaries} ORDER BY (SELECT depth FROM session_summaries s WHERE s.id = affected.id) DESC LIMIT 100`,
	).all(...params);
	for (const node of nodes) {
		db.prepare("DELETE FROM session_summary_children WHERE parent_id = ? OR child_id = ?").run(node.id, node.id);
		db.prepare("DELETE FROM session_summary_memories WHERE summary_id = ?").run(node.id);
		db.prepare("DELETE FROM memory_thread_heads WHERE agent_id = ? AND node_id = ?").run(input.agentId, node.id);
		db.prepare("DELETE FROM session_summaries WHERE id = ? AND agent_id = ?").run(node.id, input.agentId);
		add("summaries", 1);
	}
	if (nodes.length) return nodes.length;
	const artifacts = db
		.prepare(
			"DELETE FROM memory_artifacts WHERE rowid IN (SELECT rowid FROM memory_artifacts WHERE agent_id = ? AND session_key = ? LIMIT 100) RETURNING source_path",
		)
		.all(input.agentId, input.sessionKey).length;
	if (artifacts) {
		add("artifacts", artifacts);
		return artifacts;
	}
	db.prepare("DELETE FROM memory_thread_heads WHERE agent_id = ? AND session_key = ?").run(
		input.agentId,
		input.sessionKey,
	);
	for (const table of ["dreaming_evidence_consumption", "dreaming_evidence_reviews", "dreaming_evidence_exclusions"])
		db.prepare(`DELETE FROM ${table} WHERE agent_id = ? AND source_id = ? AND source_kind = 'transcript'`).run(
			input.agentId,
			input.sessionKey,
		);
	return 0;
}

async function collectFiles(root: string, paths: Set<string>, deadline: number, depth = 0): Promise<void> {
	if (Date.now() >= deadline || depth > 8) throw new Error("cleanup scan limit");
	try {
		for (const entry of await readdir(root, { withFileTypes: true })) {
			if (entry.name === ".deleted" || entry.name.endsWith(".lock")) continue;
			const path = resolve(root, entry.name);
			if (entry.isSymbolicLink()) continue;
			if (entry.isDirectory()) await collectFiles(path, paths, deadline, depth + 1);
			if (
				entry.isFile() &&
				(entry.name.endsWith(".md") ||
					entry.name.endsWith(".json") ||
					(entry.name.includes(".json.") && entry.name.endsWith(".tmp")) ||
					entry.name.endsWith(".jsonl") ||
					entry.name.endsWith(".snapshot-tmp") ||
					entry.name.endsWith(".rewrite-tmp"))
			)
				paths.add(path);
		}
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
	}
}
