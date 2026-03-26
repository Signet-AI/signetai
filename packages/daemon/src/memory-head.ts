import { createHash, randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { getDbAccessor } from "./db-accessor";
import { countChanges } from "./db-helpers";
import { loadMemoryConfig } from "./memory-config";

const AGENTS_DIR = process.env.SIGNET_PATH || join(homedir(), ".agents");

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
	| { readonly ok: false; readonly error: string; readonly code?: "busy" | "invalid" };

function hashContent(content: string): string {
	return createHash("sha256").update(content).digest("hex");
}

function projectMemoryMd(content: string): string {
	const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
	return `<!-- generated ${stamp} -->\n\n${content}`;
}

function acquireHeadLease(agentId: string, owner: string, ttlMs: number): LeaseResult {
	try {
		return getDbAccessor().withWriteTx((db) => {
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
		});
	} catch {
		return { ok: false, error: "memory head db unavailable", code: "unavailable" };
	}
}

function finalizeHeadWrite(agentId: string, token: string, content: string, revision: number): boolean {
	try {
		return getDbAccessor().withWriteTx((db) => {
			const result = db
				.prepare(
					`UPDATE memory_md_heads
					 SET content = ?, content_hash = ?, revision = ?, updated_at = ?,
					     lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL
					 WHERE agent_id = ? AND lease_token = ?`,
				)
				.run(content, hashContent(content), revision, new Date().toISOString(), agentId, token);
			return countChanges(result) === 1;
		});
	} catch {
		return false;
	}
}

function releaseHeadLease(agentId: string, token: string): void {
	try {
		getDbAccessor().withWriteTx((db) => {
			db.prepare(
				`UPDATE memory_md_heads
				 SET lease_token = NULL, lease_owner = NULL, lease_expires_at = NULL
				 WHERE agent_id = ? AND lease_token = ?`,
			).run(agentId, token);
		});
	} catch {
		// best effort
	}
}

function writeProjection(content: string): void {
	const path = join(AGENTS_DIR, "MEMORY.md");
	if (existsSync(path)) {
		const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
		const backup = join(AGENTS_DIR, "memory", `MEMORY.backup-${stamp}.md`);
		mkdirSync(join(AGENTS_DIR, "memory"), { recursive: true });
		writeFileSync(backup, readFileSync(path, "utf-8"));
	}
	writeFileSync(path, projectMemoryMd(content));
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

	const agentId = opts?.agentId ?? "default";
	const owner = opts?.owner ?? `memory-head:${process.pid}:${randomUUID().slice(0, 8)}`;
	const ttlMs = loadMemoryConfig(AGENTS_DIR).pipelineV2.worker.leaseTimeoutMs;
	const lease = acquireHeadLease(agentId, owner, ttlMs);

	if (!lease.ok && lease.code === "busy") {
		return { ok: false, error: lease.error, code: "busy" };
	}

	if (!lease.ok) {
		try {
			writeProjection(content);
			return { ok: true, revision: 0 };
		} catch (error) {
			return {
				ok: false,
				error: error instanceof Error ? error.message : String(error),
			};
		}
	}

	const next = lease.row.hash === hashContent(content) ? lease.row.revision : lease.row.revision + 1;
	const committed = finalizeHeadWrite(agentId, lease.row.token, content, next);
	if (!committed) {
		releaseHeadLease(agentId, lease.row.token);
		return { ok: false, error: "Failed to commit MEMORY.md head state" };
	}

	try {
		writeProjection(content);
		return { ok: true, revision: next };
	} catch (error) {
		return {
			ok: false,
			error: error instanceof Error ? error.message : String(error),
		};
	}
}
