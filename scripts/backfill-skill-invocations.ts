#!/usr/bin/env bun
/**
 * Backfill historical harness skill usage into skill_invocations.
 *
 * Walks Claude Code transcripts (~/.claude/projects/**\/*.jsonl), finds `Skill`
 * tool_use entries, pairs each with its tool_result for success + latency, and
 * POSTs to the daemon's /api/hooks/skill-invocation. Dedupe (the partial-unique
 * index on agent_id/harness/session_id/tool_use_id) makes re-runs safe.
 *
 * Targets either a running daemon (--port, default) or a SQLite file directly
 * (--db, for offline backfill while the daemon keeps running — WAL-safe).
 *
 *   bun scripts/backfill-skill-invocations.ts [--dir <path>] [--port <n>] [--agent-id <id>] [--dry]
 *   bun scripts/backfill-skill-invocations.ts --db ~/.agents/memory/memories.db --agent-id <id>
 */
import { Database } from "bun:sqlite";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { type ParsedSkillInvocation, parseTranscriptSkills } from "../platform/core/src/skill-transcript";

const HARNESS = "claude-code";

function arg(flag: string): string | undefined {
	const i = process.argv.indexOf(flag);
	return i >= 0 ? process.argv[i + 1] : undefined;
}

function resolveAgentId(): string {
	return arg("--agent-id")?.trim() || process.env.SIGNET_AGENT_ID?.trim() || "default";
}

function readAuthToken(): string | undefined {
	return process.env.SIGNET_API_KEY?.trim() || process.env.SIGNET_TOKEN?.trim() || undefined;
}

function walk(dir: string): string[] {
	const out: string[] = [];
	for (const name of readdirSync(dir)) {
		const path = join(dir, name);
		try {
			const st = statSync(path);
			if (st.isDirectory()) out.push(...walk(path));
			else if (name.endsWith(".jsonl")) out.push(path);
		} catch {
			// skip unreadable entries (permission errors, broken symlinks, etc.)
		}
	}
	return out;
}

/** Returns the records to send for one transcript file, plus count of skipped (no tool_result). */
function parse(path: string): { records: Array<Record<string, unknown>>; skipped: number } {
	let content: string;
	try {
		content = readFileSync(path, "utf-8");
	} catch {
		return { records: [], skipped: 0 };
	}
	const { records: parsed, skipped } = parseTranscriptSkills(content);
	const records = parsed.map((inv: ParsedSkillInvocation) => ({
		harness: HARNESS,
		skillName: inv.skillName,
		sessionId: inv.sessionId,
		toolUseId: inv.toolUseId,
		cwd: inv.cwd,
		args: inv.args,
		success: inv.success,
		latencyMs: inv.latencyMs,
		origin: "backfill",
		...(inv.createdAtMs > 0 ? { createdAt: new Date(inv.createdAtMs).toISOString() } : {}),
	}));
	return { records, skipped };
}

async function main(): Promise<void> {
	const dir = arg("--dir") ?? join(homedir(), ".claude", "projects");
	const port = arg("--port") ?? process.env.SIGNET_PORT ?? "3850";
	const dry = process.argv.includes("--dry");
	const agentId = resolveAgentId();
	const url = `http://127.0.0.1:${port}/api/hooks/skill-invocation`;
	const authToken = readAuthToken();

	const files = walk(dir);
	console.log(`Scanning ${files.length} transcripts in ${dir} for agent ${agentId}`);

	let totalSkipped = 0;
	const records: Array<Record<string, unknown>> = [];
	for (const file of files) {
		const { records: r, skipped } = parse(file);
		records.push(...r);
		totalSkipped += skipped;
	}
	console.log(
		`Found ${records.length} Skill invocations (${totalSkipped} skipped — no tool_result; dedupe handled daemon-side)`,
	);

	if (dry) {
		const bySkill = new Map<string, number>();
		for (const r of records) bySkill.set(r.skillName as string, (bySkill.get(r.skillName as string) ?? 0) + 1);
		for (const [skill, n] of [...bySkill].sort((a, b) => b[1] - a[1])) console.log(`  ${n}\t${skill}`);
		return;
	}

	const dbPath = arg("--db");
	if (dbPath) {
		insertDirect(dbPath, records, agentId);
		return;
	}

	let sent = 0;
	for (const record of records) {
		try {
			const headers: Record<string, string> = { "Content-Type": "application/json" };
			if (authToken) headers.Authorization = `Bearer ${authToken}`;
			const res = await fetch(url, {
				method: "POST",
				headers,
				body: JSON.stringify({ ...record, agentId }),
			});
			if (res.ok) {
				const body = (await res.json().catch(() => null)) as { recorded?: boolean } | null;
				if (body?.recorded === true) {
					sent++;
				} else {
					console.warn(`POST ${url} returned recorded=false`);
				}
			} else {
				console.warn(`POST ${url} failed with HTTP ${res.status}`);
			}
		} catch (err) {
			console.warn(`POST ${url} failed: ${err instanceof Error ? err.message : String(err)}`);
		}
	}
	console.log(`Posted ${sent}/${records.length} to ${url}`);
}

// Direct SQLite insert — mirrors recordSkillInvocation's INSERT OR IGNORE so the
// partial-unique idx_skill_inv_dedupe drops repeats. WAL + busy_timeout make this
// safe to run while the daemon holds the same DB.
function insertDirect(dbPath: string, records: Array<Record<string, unknown>>, agentId: string): void {
	const db = new Database(dbPath);
	db.prepare("PRAGMA busy_timeout = 5000").run();
	const stmt = db.prepare(
		`INSERT OR IGNORE INTO skill_invocations
		 (id, skill_name, agent_id, source, latency_ms, success, error_text, created_at,
		  harness, session_id, tool_use_id, cwd, origin, args)
		 VALUES (?, ?, ?, 'agent', ?, ?, NULL, ?, ?, ?, ?, ?, ?, ?)`,
	);
	const updateSkillMeta = db.prepare(
		`UPDATE skill_meta
		 SET use_count = COALESCE(use_count, 0) + 1,
		     last_used_at = ?,
		     updated_at = ?
		 WHERE agent_id = ?
		   AND entity_id IN (
			   SELECT id FROM entities
			   WHERE agent_id = ? AND lower(name) = ?
		   )`,
	);
	// Empty -> NULL so the partial-unique dedupe index (which only applies when
	// harness/session_id/tool_use_id are all NOT NULL) behaves like the recorder.
	const nn = (v: unknown): string | null => {
		const s = typeof v === "string" ? v.trim() : "";
		return s.length > 0 ? s : null;
	};
	const before = (db.query("SELECT COUNT(*) AS n FROM skill_invocations").get() as { n: number }).n;
	// Commit in batches so the write lock is released frequently, letting the
	// live daemon interleave its own writes (avoids SQLITE_BUSY on long runs).
	const BATCH_SIZE = 200;
	const insertBatch = db.transaction((rows: Array<Record<string, unknown>>) => {
		for (const r of rows) {
			const skillName = String(r.skillName).trim().toLowerCase();
			const createdAt = String(r.createdAt ?? new Date().toISOString());
			const result = stmt.run(
				crypto.randomUUID(),
				skillName,
				agentId,
				Number(r.latencyMs) || 0,
				r.success === false ? 0 : 1,
				createdAt,
				nn(r.harness),
				nn(r.sessionId),
				nn(r.toolUseId),
				nn(r.cwd),
				nn(r.origin) ?? "backfill",
				nn(r.args),
			) as { changes?: number };
			if ((result.changes ?? 0) > 0) {
				updateSkillMeta.run(createdAt, createdAt, agentId, agentId, skillName);
			}
		}
	});
	let written = 0;
	for (let i = 0; i < records.length; i += BATCH_SIZE) {
		insertBatch(records.slice(i, i + BATCH_SIZE));
		written += Math.min(BATCH_SIZE, records.length - i);
		console.log(`  batch ${Math.ceil(written / BATCH_SIZE)}: ${written}/${records.length} rows processed`);
	}
	const after = (db.query("SELECT COUNT(*) AS n FROM skill_invocations").get() as { n: number }).n;
	db.close();
	console.log(`Inserted ${after - before} new rows into ${dbPath} (${records.length} scanned, dedupe dropped repeats)`);
}

main();
