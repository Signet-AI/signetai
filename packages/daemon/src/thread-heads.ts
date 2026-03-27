import type { Database } from "bun:sqlite";

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
	return trimmed.length === 0 ? null : trimmed;
}

export function deriveThreadKey(input: {
	readonly project: string | null;
	readonly sourceRef: string | null;
	readonly sessionKey: string | null;
	readonly harness: string | null;
}): string {
	const project = input.project?.trim();
	let sourceRef = input.sourceRef?.trim();
	const sessionKey = input.sessionKey?.trim();
	const harness = input.harness?.trim();

	const base =
		project && sourceRef
			? `project:${project}|source:${sourceRef}`
			: sourceRef
				? `source:${sourceRef}`
				: sessionKey && project
					? `project:${project}|session:${sessionKey}`
					: project
						? `project:${project}`
						: sessionKey
							? `session:${sessionKey}`
							: harness
								? `harness:${harness}`
								: "thread:unscoped";
	if (!harness || base === `harness:${harness}`) return base;
	return `${base}|harness:${harness}`;
}

export function deriveThreadLabel(input: {
	readonly project: string | null;
	readonly sourceRef: string | null;
	readonly sessionKey: string | null;
	readonly harness: string | null;
}): string {
	const project = projectTag(input.project);
	let sourceRef = input.sourceRef?.trim();
	const sessionKey = input.sessionKey?.trim();
	const harness = input.harness?.trim();

	const base =
		project && sourceRef
			? `project:${project}#source:${sourceRef}`
			: sourceRef
				? `source:${sourceRef}`
				: project && sessionKey
					? `project:${project}#session:${sessionKey}`
					: project
						? `project:${project}`
						: sessionKey
							? `session:${sessionKey}`
							: harness
								? `harness:${harness}`
								: "thread:unscoped";
	if (!harness || base === `harness:${harness}`) return base;
	return `${base}#harness:${harness}`;
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
