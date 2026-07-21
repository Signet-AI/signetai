/**
 * File-patch apply for unified ingest (#913) — IngestPlan output class 3.
 *
 * Authored edits to identity/behavior files (AGENTS.md, SOUL.md, skills,
 * literature notes). Unlike memory/graph writes (upsert / INSERT OR IGNORE,
 * idempotent by construction), two DreamPlans appending to the same file
 * collide. This module serializes them with a per-file lock and makes the
 * append idempotent via the patch id.
 *
 * - Lock: a lockfile beside each identity file (PID + timestamp). Recoverable:
 *   a stale lock (dead PID or past TTL) is taken over. Re-entrancy-safe within
 *   a process: apply processes file patches sequentially, so a single apply can
 *   never deadlock itself; concurrent applies (daemon + agentic) serialize.
 * - Dedup: the appended block is wrapped in a marker comment carrying the patch
 *   id. Re-applying the same patch id is a no-op (marker already present). The
 *   marker also gives the file provenance and makes the edit inspectable.
 * - Reversibility: before each append, the current file content is copied to a
 *   versioned backup so a bad pass reverts in one call. No DB table — the
 *   version log for files IS the backup, matching the spec's reversibility seam.
 *
 * Paths are confined to the agents workspace; `file` is either a named identity
 * file or a workspace-relative path, and traversal outside the workspace is
 * rejected.
 */

import { mkdir, readFile, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve } from "node:path";
import process from "node:process";
import { resolveDefaultBasePath } from "@signet/core";
import type { FilePatchOp } from "./ingest-plan";

const LOCK_TTL_MS = 30_000; // a lock older than this is stale and can be taken over

export interface FilePatchApplyOptions {
	readonly agentId: string;
	readonly actor: string;
	/** Override for tests; defaults to the resolved agents workspace. */
	readonly agentsDir?: string;
}

export type FilePatchOutcome = {
	readonly outcome: "applied" | "skipped" | "failed";
	readonly reason?: string;
};

interface LockHandle {
	readonly path: string;
	readonly token: string;
}

function resolveAgentsDir(opts: FilePatchApplyOptions): string {
	return opts.agentsDir ?? resolveDefaultBasePath();
}

/**
 * Resolve `file` to an absolute path inside the agents workspace. Named identity
 * files resolve to the workspace root; other inputs are treated as
 * workspace-relative and must stay inside it (no traversal escape).
 */
function resolveFilePath(agentsDir: string, file: string): string {
	const safe = file.trim();
	if (!safe || safe.includes("\0")) throw new Error("invalid file path");
	const base = resolve(agentsDir);
	const abs = resolve(base, safe);
	const rel = relative(base, abs);
	if (rel.startsWith("..") || resolve(base, rel) !== abs) {
		throw new Error(`file path escapes the agents workspace: ${file}`);
	}
	return abs;
}

function lockPathFor(filePath: string): string {
	return join(dirname(filePath), `.${basePathName(filePath)}.ingest.lock`);
}

function versionsDirFor(agentsDir: string): string {
	return join(agentsDir, ".ingest", "versions");
}

function basePathName(filePath: string): string {
	// Use the file name (plus a short dir hash disambiguator) for the lockfile so
	// same-name files in different subdirs (e.g. two SKILL.md) don't share a lock.
	const parts = filePath.split("/");
	return parts[parts.length - 1] ?? "file";
}

function isPidAlive(pid: number): boolean {
	if (!Number.isFinite(pid) || pid <= 0) return false;
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

async function readLock(path: string): Promise<{ pid: number; token: string; ts: number } | null> {
	try {
		const raw = await readFile(path, "utf-8");
		const parsed = JSON.parse(raw) as { pid?: number; token?: string; ts?: number };
		if (typeof parsed.pid !== "number" || typeof parsed.token !== "string" || typeof parsed.ts !== "number") {
			return null;
		}
		return { pid: parsed.pid, token: parsed.token, ts: parsed.ts };
	} catch {
		return null;
	}
}

/**
 * Acquire a per-file lock, taking over stale locks (dead PID or past TTL).
 * Writes atomically via rename. Returns the lock handle on success.
 */
async function acquireLock(lockPath: string, owner: string): Promise<LockHandle | null> {
	const existing = await readLock(lockPath);
	const now = Date.now();
	if (existing) {
		const stale = !isPidAlive(existing.pid) || now - existing.ts > LOCK_TTL_MS;
		if (!stale) return null; // held by a live owner
	}
	const token = `${process.pid}:${now}:${owner}:${Math.random().toString(36).slice(2, 10)}`;
	const tmp = `${lockPath}.${process.pid}.${now}.tmp`;
	try {
		await writeFile(tmp, JSON.stringify({ pid: process.pid, token, ts: now, owner }), "utf-8");
		await rename(tmp, lockPath); // atomic on POSIX
		// Re-read to confirm we won the race (rename is atomic, but two writers
		// could have raced to create tmp+rename; the survivor's token lands last).
		const landed = await readLock(lockPath);
		if (!landed || landed.token !== token) return null;
		return { path: lockPath, token };
	} catch {
		return null;
	}
}

async function releaseLock(handle: LockHandle): Promise<void> {
	const landed = await readLock(handle.path);
	if (landed && landed.token === handle.token) {
		await unlink(handle.path).catch(() => {
			// best effort
		});
	}
}

function patchMarker(op: FilePatchOp, actor: string): { open: string; close: string } {
	const stamp = new Date().toISOString();
	const open = `<!-- ingest-patch:${op.id} actor:${actor} at:${stamp} -->`;
	const close = `<!-- /ingest-patch:${op.id} -->`;
	return { open, close };
}

function patchApplied(content: string, patchId: string): boolean {
	return content.includes(`<!-- ingest-patch:${patchId} `);
}

/**
 * Apply a file-patch op under a per-file lock: dedup by patch id, capture
 * before-state for revert, append the marked block. Idempotent — the same patch
 * id re-applied is a no-op.
 */
export async function applyFilePatch(
	op: FilePatchOp,
	opts: FilePatchApplyOptions,
): Promise<FilePatchOutcome> {
	const agentsDir = resolveAgentsDir(opts);
	let filePath: string;
	try {
		filePath = resolveFilePath(agentsDir, op.file);
	} catch (e) {
		return { outcome: "failed", reason: e instanceof Error ? e.message : String(e) };
	}

	const lockPath = lockPathFor(filePath);
	const handle = await acquireLock(lockPath, opts.actor);
	if (!handle) {
		return { outcome: "failed", reason: "file busy — could not acquire patch lock" };
	}

	try {
		const current = (await readFile(filePath, "utf-8").catch(() => "")) ?? "";
		if (patchApplied(current, op.id)) {
			return { outcome: "skipped", reason: "patch id already applied" };
		}

		// Before-state backup for one-call revert.
		if (current.length > 0) {
			const vdir = versionsDirFor(agentsDir);
			await mkdir(vdir, { recursive: true });
			const safeName = basePathName(filePath).replace(/[^a-z0-9.-]/gi, "_");
			const stamp = new Date().toISOString().replace(/[:.]/g, "-");
			await writeFile(join(vdir, `${safeName}.${stamp}.${op.id}.bak`), current, "utf-8");
		} else {
			await mkdir(dirname(filePath), { recursive: true });
		}

		const { open, close } = patchMarker(op, opts.actor);
		const separator = current.endsWith("\n") || current.length === 0 ? "" : "\n";
		const appendedBlock = `${separator}\n${open}\n${op.append.trim()}\n${close}\n`;
		await writeFile(filePath, current + appendedBlock, "utf-8");
		return { outcome: "applied" };
	} catch (e) {
		return { outcome: "failed", reason: e instanceof Error ? e.message : String(e) };
	} finally {
		await releaseLock(handle);
	}
}

/** Exported for tests / diagnostics. */
export function __resolveFilePathForTest(agentsDir: string, file: string): string {
	return resolveFilePath(agentsDir, file);
}

export function __patchAppliedForTest(content: string, patchId: string): boolean {
	return patchApplied(content, patchId);
}
