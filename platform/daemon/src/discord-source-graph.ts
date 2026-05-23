import { createHash } from "node:crypto";
import type { WriteDb } from "./db-accessor";
import { getDbAccessor } from "./db-accessor";
import { requireDependencyReason } from "./dependency-history";

const DISCORD_SOURCE_KIND = "source_discord_resource";

export interface DiscordSourceParticipant {
	readonly id: string;
	readonly name: string;
}

export interface IndexDiscordSourceStructureInput {
	readonly agentId: string;
	readonly sourceId: string;
	readonly sourceName: string;
	readonly guildId: string;
	readonly guildName: string;
	readonly channelId: string;
	readonly channelName: string;
	readonly threadId?: string;
	readonly threadName?: string;
	readonly messageCount: number;
	readonly participants: readonly DiscordSourceParticipant[];
}

export interface PurgeDiscordSourceStructureInput {
	readonly agentId?: string;
	readonly sourceId: string;
}

export interface ReconcileDiscordGuildStructureInput {
	readonly agentId: string;
	readonly sourceId: string;
	readonly guildId: string;
	readonly currentChannelIds: readonly string[];
	readonly reconciledChannels: readonly {
		readonly channelId: string;
		readonly conversationPaths: readonly string[];
	}[];
}

function idFor(...parts: readonly string[]): string {
	return `dcsrc_${createHash("sha256").update(parts.join("\0")).digest("hex").slice(0, 28)}`;
}

function guildCanonical(guildId: string): string {
	return `discord:${guildId}`;
}

function channelCanonical(guildId: string, channelId: string): string {
	return `${guildCanonical(guildId)}:${channelId}`;
}

function conversationCanonical(guildId: string, channelId: string, threadId?: string): string {
	return threadId
		? `${channelCanonical(guildId, channelId)}:thread:${threadId}`
		: `${channelCanonical(guildId, channelId)}:messages`;
}

function deleteEntitiesById(db: WriteDb, entityIds: readonly string[]): void {
	if (entityIds.length === 0) return;
	const placeholders = entityIds.map(() => "?").join(", ");
	db.prepare(
		`DELETE FROM entity_dependencies
		 WHERE source_entity_id IN (${placeholders}) OR target_entity_id IN (${placeholders})`,
	).run(...entityIds, ...entityIds);
	db.prepare(`DELETE FROM entities WHERE id IN (${placeholders})`).run(...entityIds);
}

function purgeOrphanedDiscordParticipants(db: WriteDb, agentId: string, sourceId: string): number {
	const participantPrefix = `discord:${sourceId}:user:`;
	return db
		.prepare(
			`DELETE FROM entities
			 WHERE agent_id = ?
			   AND source_id = ?
			   AND entity_type = 'source_document_reference'
			   AND source_path >= ?
			   AND source_path < ?
			   AND NOT EXISTS (
			     SELECT 1 FROM entity_dependencies d
			     WHERE d.agent_id = entities.agent_id
			       AND (d.source_entity_id = entities.id OR d.target_entity_id = entities.id)
			   )`,
		)
		.run(agentId, sourceId, participantPrefix, `${participantPrefix}\uffff`).changes;
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
			DISCORD_SOURCE_KIND,
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
		DISCORD_SOURCE_KIND,
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
		DISCORD_SOURCE_KIND,
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
			DISCORD_SOURCE_KIND,
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
		DISCORD_SOURCE_KIND,
		"",
		input.sourceId,
	);
	return true;
}

export function indexDiscordSourceStructure(input: IndexDiscordSourceStructureInput): void {
	const now = new Date().toISOString();

	getDbAccessor().withWriteTx((db) => {
		const sourceEntityId = idFor(input.agentId, input.sourceId, "source");
		upsertEntity(db, {
			id: sourceEntityId,
			name: input.sourceName,
			canonicalName: `discord:${input.sourceId}`,
			entityType: "source",
			agentId: input.agentId,
			sourceId: input.sourceId,
			sourcePath: input.sourceId,
			now,
		});

		const guildEntityId = idFor(input.agentId, input.sourceId, "guild", input.guildId);
		const guildCanonical = `discord:${input.guildId}`;
		upsertEntity(db, {
			id: guildEntityId,
			name: input.guildName,
			canonicalName: guildCanonical,
			entityType: "source_folder",
			agentId: input.agentId,
			sourceId: input.sourceId,
			sourcePath: `discord:${input.guildId}`,
			now,
		});
		const guildCommunityId = idFor(input.agentId, input.sourceId, "community", input.guildId);
		upsertCommunity(db, {
			id: guildCommunityId,
			name: input.guildName,
			agentId: input.agentId,
			sourceId: input.sourceId,
			now,
		});
		db.prepare("UPDATE entities SET community_id = ? WHERE id = ?").run(guildCommunityId, guildEntityId);
		upsertDependency(db, {
			sourceEntityId,
			targetEntityId: guildEntityId,
			agentId: input.agentId,
			type: "contains",
			strength: 1,
			confidence: 1,
			reason: requireDependencyReason("related_to", `Discord source contains guild ${input.guildName}`),
			sourceId: input.sourceId,
			now,
		});

		const channelEntityId = idFor(input.agentId, input.sourceId, "channel", input.channelId);
		const channelCanonical = `discord:${input.guildId}:${input.channelId}`;
		upsertEntity(db, {
			id: channelEntityId,
			name: `#${input.channelName}`,
			canonicalName: channelCanonical,
			entityType: "source_folder",
			agentId: input.agentId,
			sourceId: input.sourceId,
			sourcePath: `discord:${input.guildId}:${input.channelId}`,
			now,
		});
		db.prepare("UPDATE entities SET community_id = ? WHERE id = ?").run(guildCommunityId, channelEntityId);
		upsertDependency(db, {
			sourceEntityId: guildEntityId,
			targetEntityId: channelEntityId,
			agentId: input.agentId,
			type: "contains",
			strength: 1,
			confidence: 1,
			reason: requireDependencyReason(
				"related_to",
				`Discord guild ${input.guildName} contains channel #${input.channelName}`,
			),
			sourceId: input.sourceId,
			now,
		});

		const threadLabel = input.threadName ?? input.threadId ?? "messages";
		const documentEntityId = idFor(
			input.agentId,
			input.sourceId,
			"conversation",
			input.channelId,
			input.threadId ?? "main",
		);
		const documentCanonical = input.threadId
			? `discord:${input.guildId}:${input.channelId}:thread:${input.threadId}`
			: `discord:${input.guildId}:${input.channelId}:messages`;
		upsertEntity(db, {
			id: documentEntityId,
			name: `${threadLabel} (${input.messageCount} messages)`,
			canonicalName: documentCanonical,
			entityType: "source_document",
			agentId: input.agentId,
			sourceId: input.sourceId,
			sourcePath: documentCanonical,
			now,
		});
		db.prepare("UPDATE entities SET community_id = ? WHERE id = ?").run(guildCommunityId, documentEntityId);
		upsertDependency(db, {
			sourceEntityId: channelEntityId,
			targetEntityId: documentEntityId,
			agentId: input.agentId,
			type: "contains",
			strength: 1,
			confidence: 1,
			reason: requireDependencyReason(
				"related_to",
				`Discord channel #${input.channelName} contains conversation ${threadLabel}`,
			),
			sourceId: input.sourceId,
			now,
		});
		db.prepare(
			`DELETE FROM entity_dependencies
			 WHERE agent_id = ?
			   AND source_id = ?
			   AND source_entity_id = ?
			   AND dependency_type = 'wiki_link'`,
		).run(input.agentId, input.sourceId, documentEntityId);

		for (const participant of input.participants) {
			const participantEntityId = idFor(input.agentId, input.sourceId, "participant", participant.id);
			const userCanonical = `discord:${input.sourceId}:user:${participant.id}`;
			upsertEntity(db, {
				id: participantEntityId,
				name: participant.name,
				canonicalName: userCanonical,
				entityType: "source_document_reference",
				agentId: input.agentId,
				sourceId: input.sourceId,
				sourcePath: userCanonical,
				now,
			});
			upsertDependency(db, {
				sourceEntityId: documentEntityId,
				targetEntityId: participantEntityId,
				agentId: input.agentId,
				type: "wiki_link",
				strength: 0.7,
				confidence: 1,
				reason: requireDependencyReason("related_to", `Participant ${participant.name} in ${threadLabel}`),
				sourceId: input.sourceId,
				now,
			});
		}
		purgeOrphanedDiscordParticipants(db, input.agentId, input.sourceId);

		db.prepare(
			`UPDATE entity_communities
			 SET member_count = (
			   SELECT COUNT(*) FROM entities e WHERE e.community_id = entity_communities.id
			 ), updated_at = ?
			 WHERE agent_id = ? AND source_id = ?`,
		).run(now, input.agentId, input.sourceId);
	});
}

export function reconcileDiscordGuildStructure(input: ReconcileDiscordGuildStructureInput): void {
	const now = new Date().toISOString();
	getDbAccessor().withWriteTx((db) => {
		const currentChannelPaths = new Set(
			input.currentChannelIds.map((channelId) => channelCanonical(input.guildId, channelId)),
		);
		const staleChannelRows = db
			.prepare(
				`SELECT id, source_path
				 FROM entities
				 WHERE agent_id = ?
				   AND source_id = ?
				   AND entity_type = 'source_folder'
				   AND source_path >= ?
				   AND source_path < ?`,
			)
			.all(
				input.agentId,
				input.sourceId,
				`${guildCanonical(input.guildId)}:`,
				`${guildCanonical(input.guildId)}:\uffff`,
			) as Array<{
			id: string;
			source_path: string;
		}>;

		const stalePrefixes = staleChannelRows
			.filter((row) => row.source_path && !currentChannelPaths.has(row.source_path))
			.map((row) => row.source_path);
		const staleEntityIds = new Set<string>(
			staleChannelRows.filter((row) => stalePrefixes.includes(row.source_path)).map((row) => row.id),
		);

		for (const prefix of stalePrefixes) {
			const rows = db
				.prepare(
					`SELECT id
					 FROM entities
					 WHERE agent_id = ?
					   AND source_id = ?
					   AND source_path >= ?
					   AND source_path < ?`,
				)
				.all(input.agentId, input.sourceId, `${prefix}:`, `${prefix}:\uffff`) as Array<{ id: string }>;
			for (const row of rows) staleEntityIds.add(row.id);
		}

		for (const channel of input.reconciledChannels) {
			const prefix = channelCanonical(input.guildId, channel.channelId);
			const currentConversationPaths = new Set(channel.conversationPaths);
			const staleDocs = db
				.prepare(
					`SELECT id, source_path
					 FROM entities
					 WHERE agent_id = ?
					   AND source_id = ?
					   AND entity_type = 'source_document'
					   AND source_path >= ?
					   AND source_path < ?`,
				)
				.all(input.agentId, input.sourceId, `${prefix}:`, `${prefix}:\uffff`) as Array<{
				id: string;
				source_path: string;
			}>;
			for (const row of staleDocs) {
				if (!currentConversationPaths.has(row.source_path)) staleEntityIds.add(row.id);
			}
		}

		deleteEntitiesById(db, [...staleEntityIds]);
		purgeOrphanedDiscordParticipants(db, input.agentId, input.sourceId);
		db.prepare(
			`UPDATE entity_communities
			 SET member_count = (
			   SELECT COUNT(*) FROM entities e WHERE e.community_id = entity_communities.id
			 ), updated_at = ?
			 WHERE agent_id = ? AND source_id = ?`,
		).run(now, input.agentId, input.sourceId);
	});
}

export function purgeDiscordSourceStructure(input: PurgeDiscordSourceStructureInput): number {
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
