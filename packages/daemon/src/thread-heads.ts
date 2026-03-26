import type { Database } from "bun:sqlite";
import { basename } from "node:path";

export interface ThreadHeadSeed {
	readonly agentId: string;
	readonly nodeId: string;
	readonly content: string;
	readonly latestAt: string;
	readonly project: string | null;
	readonly sessionKey: string | null;
	readonly sourceType: string;
	readonly sourceRef: string | null;
	readonly harness: string | null;
}

function clean(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function projectTag(project: string | null): string | null {
	if (!project) return null;
	const trimmed = project.trim();
	if (trimmed.length === 0) return null;
	const name = basename(trimmed);
	return name.length > 0 ? name : trimmed;
}

export function deriveThreadKey(input: {
	readonly project: string | null;
	readonly sourceRef: string | null;
	readonly sessionKey: string | null;
	readonly harness: string | null;
}): string {
	const project = input.project?.trim();
	const sourceRef = input.sourceRef?.trim();
	const sessionKey = input.sessionKey?.trim();
	const harness = input.harness?.trim();
	if (sourceRef && project) return `project:${project}|source:${sourceRef}`;
	if (sourceRef) return `source:${sourceRef}`;
	if (sessionKey && project) return `project:${project}|session:${sessionKey}`;
	if (project) return `project:${project}`;
	if (sessionKey) return `session:${sessionKey}`;
	if (harness) return `harness:${harness}`;
	return "thread:unscoped";
}

export function deriveThreadLabel(input: {
	readonly project: string | null;
	readonly sourceRef: string | null;
	readonly sessionKey: string | null;
	readonly harness: string | null;
}): string {
	const project = projectTag(input.project);
	const sourceRef = input.sourceRef?.trim();
	const sessionKey = input.sessionKey?.trim();
	const harness = input.harness?.trim();
	if (project && sourceRef) return `project:${project}#source:${sourceRef}`;
	if (sourceRef) return `source:${sourceRef}`;
	if (project && sessionKey) return `project:${project}#session:${sessionKey}`;
	if (project) return `project:${project}`;
	if (sessionKey) return `session:${sessionKey}`;
	if (harness) return `harness:${harness}`;
	return "thread:unscoped";
}

export function summarizeThreadContent(content: string, limit = 240): string {
	const base = clean(content);
	if (base.length <= limit) return base;
	return `${base.slice(0, Math.max(1, limit - 3)).trim()}...`;
}

function hasThreadHeadsTable(db: Database): boolean {
	const row = db.prepare(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'memory_thread_heads'`).get();
	return row !== undefined;
}

export function upsertThreadHead(db: Database, seed: ThreadHeadSeed): void {
	if (!hasThreadHeadsTable(db)) return;
	const key = deriveThreadKey({
		project: seed.project,
		sourceRef: seed.sourceRef,
		sessionKey: seed.sessionKey,
		harness: seed.harness,
	});
	const label = deriveThreadLabel({
		project: seed.project,
		sourceRef: seed.sourceRef,
		sessionKey: seed.sessionKey,
		harness: seed.harness,
	});
	const sample = summarizeThreadContent(seed.content, 240);
	const now = new Date().toISOString();
	db.prepare(
		`INSERT INTO memory_thread_heads (
			agent_id, thread_key, label, project, session_key, source_type,
			source_ref, harness, node_id, latest_at, sample, updated_at
		) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		ON CONFLICT(agent_id, thread_key) DO UPDATE SET
			label = excluded.label,
			project = excluded.project,
			session_key = excluded.session_key,
			source_type = excluded.source_type,
			source_ref = excluded.source_ref,
			harness = excluded.harness,
			node_id = excluded.node_id,
			latest_at = excluded.latest_at,
			sample = excluded.sample,
			updated_at = excluded.updated_at
		WHERE excluded.latest_at >= memory_thread_heads.latest_at`,
	).run(
		seed.agentId,
		key,
		label,
		seed.project,
		seed.sessionKey,
		seed.sourceType,
		seed.sourceRef,
		seed.harness,
		seed.nodeId,
		seed.latestAt,
		sample,
		now,
	);
}
