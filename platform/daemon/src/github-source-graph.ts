import { createHash } from "node:crypto";
import type { WriteDb } from "./db-accessor";
import { getDbAccessor } from "./db-accessor";
import { requireDependencyReason } from "./dependency-history";
import type { GitHubResource } from "./github-source-fetch";

const GITHUB_SOURCE_KIND = "source_github_resource";

export interface IndexGitHubSourceStructureInput {
	readonly agentId: string;
	readonly sourceId: string;
	readonly sourceName: string;
	readonly repo: string;
	readonly resource: GitHubResource;
}

export interface PurgeGitHubSourceStructureInput {
	readonly agentId?: string;
	readonly sourceId: string;
}

function idFor(...parts: readonly string[]): string {
	return `ghsrc_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 28)}`;
}

function upsertEntity(
	db: WriteDb,
	input: {
		readonly id: string;
		readonly name: string;
		readonly canonicalName: string;
		readonly entityType: string;
		readonly agentId: string;
		readonly sourceId: string;
		readonly sourcePath: string;
		readonly now: string;
	},
): string {
	const uniqueName = `${input.name} — ${input.canonicalName} — ${input.agentId}`;
	const existing = db
		.prepare("SELECT id FROM entities WHERE canonical_name = ? AND agent_id = ? LIMIT 1")
		.get(input.canonicalName, input.agentId) as { id: string } | undefined;
	if (existing) {
		db.prepare(
			`UPDATE entities
			 SET name = ?, entity_type = ?, mentions = MAX(COALESCE(mentions, 0), 1), updated_at = ?,
			     source_id = ?, source_kind = ?, source_path = ?, source_root = ?
			 WHERE id = ?`,
		).run(
			uniqueName,
			input.entityType,
			input.now,
			input.sourceId,
			GITHUB_SOURCE_KIND,
			input.sourcePath,
			input.sourceId,
			existing.id,
		);
		return existing.id;
	}
	db.prepare(
		`INSERT INTO entities
		 (id, name, canonical_name, entity_type, agent_id, mentions, created_at, updated_at,
		  source_id, source_kind, source_path, source_root)
		 VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?)`,
	).run(
		input.id,
		uniqueName,
		input.canonicalName,
		input.entityType,
		input.agentId,
		input.now,
		input.now,
		input.sourceId,
		GITHUB_SOURCE_KIND,
		input.sourcePath,
		input.sourceId,
	);
	return input.id;
}

function upsertCommunity(
	db: WriteDb,
	input: {
		readonly id: string;
		readonly name: string;
		readonly agentId: string;
		readonly sourceId: string;
		readonly now: string;
	},
): void {
	db.prepare(
		`INSERT INTO entity_communities
		 (id, agent_id, name, cohesion, member_count, created_at, updated_at, source_id, source_kind, source_path, source_root)
		 VALUES (?, ?, ?, 1.0, 0, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET
		   name = excluded.name,
		   updated_at = excluded.updated_at,
		   source_id = excluded.source_id`,
	).run(
		input.id,
		input.agentId,
		input.name,
		input.now,
		input.now,
		input.sourceId,
		GITHUB_SOURCE_KIND,
		"",
		input.sourceId,
	);
}

function upsertDependency(
	db: WriteDb,
	input: {
		readonly sourceEntityId: string;
		readonly targetEntityId: string;
		readonly agentId: string;
		readonly type: string;
		readonly strength: number;
		readonly confidence: number;
		readonly reason: string;
		readonly sourceId: string;
		readonly now: string;
	},
): boolean {
	const existing = db
		.prepare(
			`SELECT id FROM entity_dependencies
			 WHERE source_entity_id = ? AND target_entity_id = ? AND dependency_type = ? AND agent_id = ?
			 LIMIT 1`,
		)
		.get(input.sourceEntityId, input.targetEntityId, input.type, input.agentId) as { id: string } | undefined;
	if (existing) {
		db.prepare(
			`UPDATE entity_dependencies
			 SET strength = MAX(strength, ?), confidence = MAX(COALESCE(confidence, 0), ?),
			     reason = ?, updated_at = ?, source_id = ?, source_kind = ?, source_path = ?, source_root = ?
			 WHERE id = ?`,
		).run(
			input.strength,
			input.confidence,
			input.reason,
			input.now,
			input.sourceId,
			GITHUB_SOURCE_KIND,
			"",
			input.sourceId,
			existing.id,
		);
		return false;
	}
	const id = idFor("dep", input.agentId, input.type, input.sourceEntityId, input.targetEntityId);
	db.prepare(
		`INSERT INTO entity_dependencies
		 (id, source_entity_id, target_entity_id, agent_id, dependency_type, strength, confidence, reason,
		  created_at, updated_at, source_id, source_kind, source_path, source_root)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
	).run(
		id,
		input.sourceEntityId,
		input.targetEntityId,
		input.agentId,
		input.type,
		input.strength,
		input.confidence,
		input.reason,
		input.now,
		input.now,
		input.sourceId,
		GITHUB_SOURCE_KIND,
		"",
		input.sourceId,
	);
	return true;
}

export function indexGitHubSourceStructure(input: IndexGitHubSourceStructureInput): void {
	const now = new Date().toISOString();
	const sourcePath = resourceSourcePath(input.repo, input.resource);

	getDbAccessor().withWriteTx((db) => {
		const sourceEntityId = idFor(input.agentId, input.sourceId, "source");
		upsertEntity(db, {
			id: sourceEntityId,
			name: input.sourceName,
			canonicalName: `github:${input.sourceId}`,
			entityType: "source",
			agentId: input.agentId,
			sourceId: input.sourceId,
			sourcePath: input.sourceId,
			now,
		});

		const repoEntityId = idFor(input.agentId, input.sourceId, "repo", input.repo);
		const repoCanonical = `github:${input.sourceId}:${input.repo}`;
		upsertEntity(db, {
			id: repoEntityId,
			name: input.repo,
			canonicalName: repoCanonical,
			entityType: "source_folder",
			agentId: input.agentId,
			sourceId: input.sourceId,
			sourcePath: `github:${input.repo}`,
			now,
		});
		const repoCommunityId = idFor(input.agentId, input.sourceId, "community", input.repo);
		upsertCommunity(db, {
			id: repoCommunityId,
			name: input.repo,
			agentId: input.agentId,
			sourceId: input.sourceId,
			now,
		});
		db.prepare("UPDATE entities SET community_id = ? WHERE id = ?").run(repoCommunityId, repoEntityId);
		upsertDependency(db, {
			sourceEntityId,
			targetEntityId: repoEntityId,
			agentId: input.agentId,
			type: "contains",
			strength: 1,
			confidence: 1,
			reason: requireDependencyReason("related_to", `GitHub source contains repo ${input.repo}`),
			sourceId: input.sourceId,
			now,
		});

		const resourceEntityId = idFor(
			input.agentId,
			input.sourceId,
			"resource",
			input.repo,
			input.resource.type,
			String(input.resource.number ?? input.resource.path),
		);
		const resourceCanonical = `github:${input.sourceId}:${sourcePath}`;
		upsertEntity(db, {
			id: resourceEntityId,
			name: resourceDisplayName(input.resource),
			canonicalName: resourceCanonical,
			entityType: "source_document",
			agentId: input.agentId,
			sourceId: input.sourceId,
			sourcePath: sourcePath,
			now,
		});
		db.prepare("UPDATE entities SET community_id = ? WHERE id = ?").run(repoCommunityId, resourceEntityId);
		upsertDependency(db, {
			sourceEntityId: repoEntityId,
			targetEntityId: resourceEntityId,
			agentId: input.agentId,
			type: "contains",
			strength: 1,
			confidence: 1,
			reason: requireDependencyReason(
				"related_to",
				`GitHub repo ${input.repo} contains ${input.resource.type} ${input.resource.number ?? input.resource.path}`,
			),
			sourceId: input.sourceId,
			now,
		});

		for (const label of input.resource.labels) {
			const labelEntityId = idFor(input.agentId, input.sourceId, "label", label);
			upsertEntity(db, {
				id: labelEntityId,
				name: label,
				canonicalName: `github:${input.sourceId}:${input.repo}:label:${label}`,
				entityType: "source_document_reference",
				agentId: input.agentId,
				sourceId: input.sourceId,
				sourcePath: `github:${input.repo}:label:${label}`,
				now,
			});
			upsertDependency(db, {
				sourceEntityId: resourceEntityId,
				targetEntityId: labelEntityId,
				agentId: input.agentId,
				type: "wiki_link",
				strength: 0.8,
				confidence: 1,
				reason: requireDependencyReason("related_to", `GitHub ${input.resource.type} labeled ${label}`),
				sourceId: input.sourceId,
				now,
			});
		}

		const body = input.resource.body ?? "";
		const refs = extractGitHubRefs(body, input.repo);
		for (const ref of refs) {
			const refEntityId = idFor(input.agentId, input.sourceId, "resource", input.repo, ref.type, String(ref.number));
			upsertEntity(db, {
				id: refEntityId,
				name: `${ref.type} #${ref.number}`,
				canonicalName: `github:${input.sourceId}:github:${input.repo}:${ref.type}:${ref.number}`,
				entityType: "source_document_reference",
				agentId: input.agentId,
				sourceId: input.sourceId,
				sourcePath: `github:${input.repo}:${ref.type}:${ref.number}`,
				now,
			});
			upsertDependency(db, {
				sourceEntityId: resourceEntityId,
				targetEntityId: refEntityId,
				agentId: input.agentId,
				type: "wiki_link",
				strength: ref.type === "pull" ? 0.9 : 0.7,
				confidence: 0.8,
				reason: requireDependencyReason(
					"related_to",
					`GitHub ${input.resource.type} references ${ref.type} #${ref.number}`,
				),
				sourceId: input.sourceId,
				now,
			});
		}

		db.prepare(
			`UPDATE entity_communities
			 SET member_count = (
			   SELECT COUNT(*) FROM entities e WHERE e.community_id = entity_communities.id
			 ), updated_at = ?
			 WHERE agent_id = ? AND source_id = ?`,
		).run(now, input.agentId, input.sourceId);
	});
}

function resourceSourcePath(repo: string, resource: GitHubResource): string {
	if (resource.type === "doc" && resource.path) return `github:${repo}:docs:${resource.path}`;
	return `github:${repo}:${resource.type}:${resource.number}`;
}

function resourceDisplayName(resource: GitHubResource): string {
	if (resource.type === "doc" && resource.path) return resource.path.split("/").pop() ?? resource.path;
	return `${resource.type} #${resource.number}: ${resource.title}`;
}

interface GitHubRef {
	readonly type: string;
	readonly number: number;
}

export function extractGitHubRefs(body: string, _repo: string): GitHubRef[] {
	const refs = new Map<string, GitHubRef>();
	const patterns = [
		/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|ref[s]?|see)\s+#(\d+)/gi,
		/(?:close[sd]?|fix(?:e[sd])?|resolve[sd]?|ref[s]?|see)\s+https:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/(\d+)/gi,
		/https:\/\/github\.com\/[^/]+\/[^/]+\/(issues|pull)\/(\d+)/gi,
		/#(\d+)/g,
	];
	for (const pattern of patterns) {
		let match: RegExpExecArray | null;
		while ((match = pattern.exec(body))) {
			if (pattern === patterns[3]) {
				const num = Number(match[1]);
				if (num > 0 && num < 1_000_000) {
					const key = `issue:${num}`;
					if (!refs.has(key)) refs.set(key, { type: "issue", number: num });
				}
			} else if (pattern === patterns[1] || pattern === patterns[2]) {
				const type = match[1] === "pull" ? "pull" : "issue";
				const num = Number(match[2]);
				if (num > 0) refs.set(`${type}:${num}`, { type, number: num });
			} else {
				const num = Number(match[1]);
				if (num > 0 && num < 1_000_000) {
					refs.set(`issue:${num}`, { type: "issue", number: num });
				}
			}
		}
	}
	return [...refs.values()];
}

export function purgeGitHubSourceStructure(input: PurgeGitHubSourceStructureInput): number {
	const agentWhere = input.agentId ? "agent_id = ? AND " : "";
	const params = input.agentId ? [input.agentId, input.sourceId] : [input.sourceId];
	return getDbAccessor().withWriteTx((db) => {
		const attrs = db.prepare(`DELETE FROM entity_attributes WHERE ${agentWhere}source_id = ?`).run(...params).changes;
		const deps = db.prepare(`DELETE FROM entity_dependencies WHERE ${agentWhere}source_id = ?`).run(...params).changes;
		const entities = db.prepare(`DELETE FROM entities WHERE ${agentWhere}source_id = ?`).run(...params).changes;
		const communities = db
			.prepare(`DELETE FROM entity_communities WHERE ${agentWhere}source_id = ?`)
			.run(...params).changes;
		return entities + attrs + deps + communities;
	});
}

export interface PurgeGitHubResourceStructureInput {
	readonly sourceId: string;
	readonly repo: string;
	readonly agentId: string;
	readonly resource: GitHubResource;
}

export function purgeGitHubResourceStructure(input: PurgeGitHubResourceStructureInput): number {
	const sourcePath = resourceSourcePath(input.repo, input.resource);
	const canonicalName = `github:${input.sourceId}:${sourcePath}`;
	return getDbAccessor().withWriteTx((db) => {
		const entity = db
			.prepare("SELECT id FROM entities WHERE canonical_name = ? AND agent_id = ? LIMIT 1")
			.get(canonicalName, input.agentId) as { id: string } | undefined;
		if (!entity) return 0;
		const attrs = db.prepare("DELETE FROM entity_attributes WHERE entity_id = ? AND agent_id = ?").run(entity.id, input.agentId).changes;
		const deps = db.prepare("DELETE FROM entity_dependencies WHERE (source_entity_id = ? OR target_entity_id = ?) AND agent_id = ?").run(entity.id, entity.id, input.agentId).changes;
		const entities = db.prepare("DELETE FROM entities WHERE id = ? AND agent_id = ?").run(entity.id, input.agentId).changes;
		return entities + attrs + deps;
	});
}
