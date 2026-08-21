import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveDefaultBasePath, scanMemoryContent } from "@signet/core";
import { getDbAccessor, hasDbAccessor } from "./db-accessor";
import { countChanges } from "./db-helpers";
import { loadMemoryConfig } from "./memory-config";
import { countTokens } from "./pipeline/tokenizer";

export const MEMORY_HEAD_MAX_TOKENS = 1000;

function getAgentsDir(): string {
	return resolveDefaultBasePath();
}

interface LeaseRow {
	readonly token: string;
	readonly revision: number;
	readonly hash: string;
}

type LeaseResult =
	| { readonly ok: true; readonly row: LeaseRow }
	| { readonly ok: false; readonly error: string; readonly code: "busy" | "unavailable" };

export type MemoryHeadWriteResult =
	| { readonly ok: true; readonly revision: number }
	| { readonly ok: false; readonly error: string; readonly code?: "busy" | "invalid" | "unavailable" };

export interface MemoryHeadEntry {
	readonly id: string;
	readonly text: string;
	readonly operation: "added" | "updated" | "removed" | "deferred" | "no-op";
	readonly sourceRefs: readonly string[];
	readonly supportingQuotes: readonly string[];
}

export interface MemoryHeadCuration {
	readonly passId: string;
	readonly agentId: string;
	readonly baseRevision: number;
	readonly baseHash: string;
	readonly content: string;
	readonly entries: readonly MemoryHeadEntry[];
}

export type MemoryHeadCurationResult =
	| { readonly ok: true; readonly revision: number; readonly hash: string; readonly changed: boolean }
	| { readonly ok: false; readonly error: string; readonly code: "invalid" | "busy" };

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function projectMemoryMd(content: string): { readonly body: string; readonly file: string } {
	const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
	const prefix = `<!-- generated ${stamp} -->\n\n`;
	const body = content.trim();
	if (countTokens(`${prefix}${body}`) > MEMORY_HEAD_MAX_TOKENS) {
		throw new Error(`MEMORY.md candidate exceeds the ${MEMORY_HEAD_MAX_TOKENS}-token limit`);
	}
	return { body, file: `${prefix}${body}` };
}

function normalizeAgentId(agentId?: string): string {
	const next = agentId?.trim();
	return next && next.length > 0 ? next : "default";
}

function isSafeAgentId(agentId: string): boolean {
	return agentId === "default" || /^[a-z0-9][a-z0-9-]*$/.test(agentId);
}

function resolveMemoryHeadPath(agentsDir: string, agentId: string): string {
	if (agentId === "default") return join(agentsDir, "MEMORY.md");
	return join(agentsDir, "agents", agentId, "MEMORY.md");
}

function acquireHeadLease(agentId: string, owner: string, ttlMs: number): LeaseResult {
	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
		return getDbAccessor().withWriteTx((db: import("./db-accessor").WriteDb) => {
			const table = db
				.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_md_heads'`)
				.get();
			if (!table) {
				return { ok: false, error: "memory_md_heads table unavailable", code: "unavailable" };
			}

			const now = new Date().toISOString();
			db.prepare(
				`INSERT OR IGNORE INTO memory_md_heads
				 (agent_id, content, content_hash, revision, updated_at)
				 VALUES (?, '', '', 0, ?)`,
			).run(agentId, now);

			const active = db
				.prepare(
					`SELECT revision, content_hash, lease_token, lease_expires_at
					 FROM memory_md_heads
					 WHERE agent_id = ?`,
				)
				.get(agentId) as
				| {
						revision: number;
						content_hash: string;
						lease_token: string | null;
						lease_expires_at: string | null;
				  }
				| undefined;

			if (!active) {
				return { ok: false, error: "memory head state missing", code: "unavailable" };
			}

			const expiresAt = active.lease_expires_at ? Date.parse(active.lease_expires_at) : 0;
			if (active.lease_token && Number.isFinite(expiresAt) && expiresAt > Date.now()) {
				return { ok: false, error: "MEMORY.md write busy", code: "busy" };
			}

			const token = randomUUID();
			const leaseUntil = new Date(Date.now() + ttlMs).toISOString();
			const result = db
				.prepare(
					`UPDATE memory_md_heads
					 SET lease_token = ?, lease_owner = ?, lease_expires_at = ?
					 WHERE agent_id = ?`,
				)
				.run(token, owner, leaseUntil, agentId);
			if (countChanges(result) === 0) {
				return { ok: false, error: "MEMORY.md write busy", code: "busy" };
			}

			return {
				ok: true,
				row: {
					token,
					revision: active.revision,
					hash: active.content_hash,
				},
			};
		}, "memory-head.ts:82");
	} catch {
		return { ok: false, error: "memory head db unavailable", code: "unavailable" };
	}
}

function finalizeHeadWrite(agentId: string, token: string, content: string, revision: number): boolean {
	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
		return getDbAccessor().withWriteTx((db: import("./db-accessor").WriteDb) => {
			const result = db
				.prepare(
					`UPDATE memory_md_heads
					 SET content = ?, content_hash = ?, revision = ?, updated_at = ?,
					     lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL
					 WHERE agent_id = ? AND lease_token = ?`,
				)
				.run(content, hashContent(content), revision, new Date().toISOString(), agentId, token);
			return countChanges(result) === 1;
		}, "memory-head.ts:151");
	} catch {
		return false;
	}
}

function releaseHeadLease(agentId: string, token: string): void {
	try {
		// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
		getDbAccessor().withWriteTx((db: import("./db-accessor").WriteDb) => {
			db.prepare(
				`UPDATE memory_md_heads
				 SET lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL
				 WHERE agent_id = ? AND lease_token = ?`,
			).run(agentId, token);
		}, "memory-head.ts:170");
	} catch {
		// best effort
	}
}

function writeProjection(file: string, agentId: string): void {
	const agentsDir = getAgentsDir();
	const path = resolveMemoryHeadPath(agentsDir, agentId);
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	if (existsSync(path)) {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const backup = join(dir, "memory", `MEMORY.backup-${stamp}.md`);
		mkdirSync(dirname(backup), { recursive: true });
		writeFileSync(backup, readFileSync(path, "utf-8"));
	}
	writeFileSync(path, file);
}

export function writeMemoryHead(
	content: string,
	opts?: {
		readonly agentId?: string;
		readonly owner?: string;
	},
): MemoryHeadWriteResult {
	const trimmed = content.trim();
	if (!trimmed) {
		return { ok: false, error: "Refusing to write empty content to MEMORY.md", code: "invalid" };
	}
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		try {
			JSON.parse(trimmed);
			return { ok: false, error: "Refusing to write JSON to MEMORY.md", code: "invalid" };
		} catch {
			// markdown can start with [ or {
		}
	}
	const safety = scanMemoryContent(trimmed);
	if (!safety.contextEligible) {
		return {
			ok: false,
			error: `Refusing to write ${safety.status} content to MEMORY.md (${safety.reasons.join(", ")})`,
			code: "invalid",
		};
	}

	let projected: { readonly body: string; readonly file: string };
	try {
		projected = projectMemoryMd(trimmed);
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error), code: "invalid" };
	}
	const agentId = normalizeAgentId(opts?.agentId);
	if (!isSafeAgentId(agentId)) {
		return { ok: false, error: `Invalid agentId for MEMORY.md path: ${agentId}`, code: "invalid" };
	}
	if (hasDbAccessor() && agentId !== "default") {
		return {
			ok: false,
			error: "Legacy synthesis writer disabled; curated memory head is authoritative",
			code: "invalid",
		};
	}
	const owner = opts?.owner ?? `memory-head:${process.pid}:${randomUUID().slice(0, 8)}`;
	const ttlMs = loadMemoryConfig(getAgentsDir()).pipelineV2.worker.leaseTimeoutMs;
	const lease = acquireHeadLease(agentId, owner, ttlMs);

	if (!lease.ok && lease.code === "busy") {
		return { ok: false, error: lease.error, code: "busy" };
	}

	if (!lease.ok) {
		if (!hasDbAccessor()) {
			try {
				writeProjection(projected.file, agentId);
				return { ok: true, revision: 0 };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		}
		return { ok: false, error: lease.error, code: lease.code === "unavailable" ? "unavailable" : lease.code };
	}

	const next = lease.row.hash === hashContent(projected.body) ? lease.row.revision : lease.row.revision + 1;
	const committed = finalizeHeadWrite(agentId, lease.row.token, projected.body, next);
	if (!committed) {
		releaseHeadLease(agentId, lease.row.token);
		return { ok: false, error: "Failed to commit MEMORY.md head state" };
	}

	try {
		writeProjection(projected.file, agentId);
		return { ok: true, revision: next };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}

/** Audited content-pass seam; hygiene passes have no way to invoke this. */
export async function curateMemoryHead(input: MemoryHeadCuration): Promise<MemoryHeadCurationResult> {
	if (!input.passId.trim() || !input.agentId.trim())
		return { ok: false, error: "passId and agentId are required", code: "invalid" };
	for (const entry of input.entries) {
		if (!entry.id.trim() || !entry.text.trim())
			return { ok: false, error: "Memory head entries require id and text", code: "invalid" };
		if (
			entry.operation !== "deferred" &&
			entry.operation !== "no-op" &&
			(!entry.sourceRefs.length || !entry.supportingQuotes.length)
		)
			return { ok: false, error: `Entry ${entry.id} requires provenance`, code: "invalid" };
	}
	let projected: { readonly body: string; readonly file: string };
	try {
		projected = projectMemoryMd(input.content.trim());
	} catch (error) {
		return { ok: false, error: error instanceof Error ? error.message : String(error), code: "invalid" };
	}
	const lease = acquireHeadLease(
		input.agentId,
		`dreaming:${input.passId}`,
		loadMemoryConfig(getAgentsDir()).pipelineV2.worker.leaseTimeoutMs,
	);
	if (!lease.ok) return { ok: false, error: lease.error, code: lease.code === "busy" ? "busy" : "invalid" };
	const hash = hashContent(projected.body);
	const next = lease.row.hash === hash ? lease.row.revision : lease.row.revision + 1;
	const path = resolveMemoryHeadPath(getAgentsDir(), input.agentId);
	const previous = existsSync(path) ? readFileSync(path, "utf-8") : undefined;
	try {
		await getDbAccessor().withWriteTxAsync((db: import("./db-accessor").WriteDb) => {
			// Keep the database publication, audit rows, and projection in one
			// admission. Audit failures therefore happen before the projection is
			// changed, and projection failures roll the database transaction back.
			db.prepare(
				`UPDATE memory_md_heads SET content = ?, content_hash = ?, revision = ?, updated_at = ?, lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL WHERE agent_id = ? AND lease_token = ?`,
			).run(projected.body, hash, next, new Date().toISOString(), input.agentId, lease.row.token);
			for (const entry of input.entries)
				db.prepare(
					`INSERT INTO memory_head_revisions (id, agent_id, revision, content, content_hash, rendered_token_count, pass_id, base_revision, base_hash, created_at, entry_id, entry_text, operation, source_refs_json, supporting_quotes_json) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
				).run(
					randomUUID(),
					input.agentId,
					next,
					input.content.trim(),
					hash,
					countTokens(input.content.trim()),
					input.passId,
					input.baseRevision,
					input.baseHash,
					new Date().toISOString(),
					entry.id,
					entry.text,
					entry.operation,
					JSON.stringify(entry.sourceRefs),
					JSON.stringify(entry.supportingQuotes),
				);
			const manifestUpdate = db
				.prepare(
					`UPDATE dreaming_passes
					 SET head_revision = ?, head_hash = ?, head_added = ?, head_updated = ?,
					     head_removed = ?, head_deferred = ?, head_no_op = ?
					 WHERE id = ? AND agent_id = ?`,
				)
				.run(
					next,
					hash,
					input.entries.filter((entry) => entry.operation === "added").length,
					input.entries.filter((entry) => entry.operation === "updated").length,
					input.entries.filter((entry) => entry.operation === "removed").length,
					input.entries.filter((entry) => entry.operation === "deferred").length,
					input.entries.filter((entry) => entry.operation === "no-op").length,
					input.passId,
					input.agentId,
				);
			if (manifestUpdate.changes !== 1) throw new Error("Dreaming pass manifest row is missing");
			writeProjection(projected.file, input.agentId);
		}, { siteToken: "memory-head.ts:310" });
	} catch (error) {
		try {
			if (previous === undefined) {
				if (existsSync(path)) rmSync(path);
			} else writeFileSync(path, previous);
		} catch {
			/* preserve the original failure */
		}
		return { ok: false, error: error instanceof Error ? error.message : String(error), code: "invalid" };
	}
	return {
		ok: true,
		revision: next,
		hash,
		changed: next !== input.baseRevision || hash !== input.baseHash,
	};
}
