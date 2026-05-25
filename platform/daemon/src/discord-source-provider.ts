import {
	type SignetSourceEntry,
	type SourceFailureState,
	type SourceProviderKind,
	parseDiscordSettings,
} from "@signet/core";
import { resolveDaemonAgentId } from "./agent-id";
import { getDbAccessor } from "./db-accessor";
import { countChanges } from "./db-helpers";
import { syncDiscordDesktopCacheSource } from "./discord-desktop-cache-source";
import { setDiscordGatewaySocketFactoryForTest, syncDiscordGatewayTail } from "./discord-gateway-tail";
import {
	DISCORD_CHANNEL_TYPES,
	type DiscordAttachment,
	type DiscordChannel,
	type DiscordEmbed,
	type DiscordFetchConfig,
	type DiscordFetchError,
	type DiscordGuild,
	type DiscordGuildMember,
	type DiscordMessage,
	discordDisplayName,
	fetchArchivedThreads,
	fetchChannelMessages,
	fetchGuild,
	fetchGuildActiveThreads,
	fetchGuildChannels,
	fetchGuildMembers,
	fetchThreadMembers,
	isDiscordTextReadableChannel,
	isDiscordThread,
	snowflakeIdForTimestamp,
} from "./discord-source-fetch";
import { indexExternalMemoryArtifact } from "./memory-lineage";
import { getSecret } from "./secrets";
import { indexSourceArtifactStructure, purgeSourceArtifactStructure } from "./source-artifact-graph";
import type { SourceProviderAdapter, SourceProviderSyncContext, SourceProviderSyncResult } from "./source-providers";
import { purgeSourceOwnedRows } from "./source-purge";

const DISCORD_PROVIDER_KIND: SourceProviderKind = "discord";
const DISCORD_HARNESS = "discord";
const DEFAULT_MAX_MEMBERS_PER_GUILD = 10_000;
const DEFAULT_MAX_THREADS_PER_PARENT = 1_000;
const DISCORD_MESSAGE_HISTORY_KINDS = [
	"source_discord_message_window",
	"source_discord_message",
	"source_discord_message_tombstone",
	"source_discord_message_event",
	"source_discord_mention",
	"source_discord_attachment",
	"source_discord_embed",
	"source_discord_poll",
] as const;

export { setDiscordGatewaySocketFactoryForTest };

export const discordSourceProvider: SourceProviderAdapter = {
	kind: "discord",
	sync: syncDiscordSource,
	purge: (source, agentId) => purgeSourceOwnedRows({ sourceId: source.id, agentId }),
};

async function syncDiscordSource(context: SourceProviderSyncContext): Promise<SourceProviderSyncResult> {
	const settings = parseDiscordSettings(context.source.providerSettings);
	const agentId = context.agentId || resolveDaemonAgentId();
	if (settings.syncMode === "desktop-cache") {
		return syncDiscordDesktopCacheSource({
			source: context.source,
			agentId,
			cachePath: settings.desktopCachePath ?? context.source.root,
			fullScan: settings.desktopCacheFullScan,
			shouldContinue: context.shouldContinue,
			onProgress: context.onProgress,
		});
	}
	if (settings.guildIds.length === 0) throw new Error("Discord source has no guild IDs");
	if (!settings.tokenRef) throw new Error("Discord source has no tokenRef");
	const failures: SourceFailureState[] = [];
	let indexed = 0;
	let scanned = 0;
	const syncStartedAt = new Date().toISOString();
	const total = settings.guildIds.length;
	const token = await getSecret(settings.tokenRef);
	const fetchConfig: DiscordFetchConfig = { token };
	const incrementalMessageChannelPaths = new Set<string>();

	if (settings.syncMode === "gateway-tail")
		return syncDiscordGatewayTailSource(context, agentId, token, settings.guildIds);

	const sinceId = settings.since ? snowflakeIdForTimestamp(settings.since) : undefined;
	for (const guildId of settings.guildIds) {
		if (!context.shouldContinue()) break;
		context.onProgress?.({ scanned, total, indexed, currentPath: `discord://guild/${guildId}` });
		let guild: DiscordGuild | null;
		try {
			guild = await fetchGuild(fetchConfig, guildId);
		} catch (err) {
			const failure = failureState(context.source, `Discord guild fetch failed for ${guildId}: ${errorMessage(err)}`, {
				guildId,
				phase: "guild",
			});
			failures.push(failure);
			writeFailureArtifact(context.source, agentId, failure);
			indexed++;
			scanned++;
			continue;
		}
		if (!guild) {
			const failure = failureState(context.source, `Discord guild unavailable or forbidden: ${guildId}`, { guildId });
			failures.push(failure);
			writeFailureArtifact(context.source, agentId, failure);
			indexed++;
			scanned++;
			continue;
		}

		indexed += writeArtifact(context.source, agentId, guildArtifact(context.source, guild));
		const channels = await fetchGuildChannels(fetchConfig, guildId);
		indexed += writeFetchFailures(context.source, agentId, failures, channels.errors, { guildId, phase: "channels" });
		const channelFilter = buildChannelFilter(settings.channelFilter);
		const channelRows = applyChannelFilter(channels.data, channelFilter);
		const filteredChannelIds = new Set(channelRows.map((channel) => channel.id));

		for (const channel of channelRows) {
			if (!context.shouldContinue()) break;
			indexed += writeArtifact(context.source, agentId, channelArtifact(context.source, guild, channel));
		}

		if (settings.includeMembers) {
			const members = await fetchGuildMembers(fetchConfig, guildId, DEFAULT_MAX_MEMBERS_PER_GUILD);
			indexed += writeFetchFailures(context.source, agentId, failures, members.errors, { guildId, phase: "members" });
			for (const member of members.data) {
				if (!context.shouldContinue()) break;
				indexed += writeArtifact(context.source, agentId, memberArtifact(guild, member));
			}
		}

		const threadMap = new Map<string, DiscordChannel>();
		if (settings.includeThreads) {
			const activeThreads = await fetchGuildActiveThreads(fetchConfig, guildId);
			indexed += writeFetchFailures(context.source, agentId, failures, activeThreads.errors, {
				guildId,
				phase: "active_threads",
			});
			for (const thread of activeThreads.data) {
				if (!matchesThreadFilter(thread, channelFilter, filteredChannelIds)) continue;
				threadMap.set(thread.id, thread);
			}
			if (settings.includeArchivedThreads) {
				const threadCatalogParents = (channelFilter ? channels.data : channelRows).filter(isThreadParent);
				for (const channel of threadCatalogParents) {
					if (!context.shouldContinue()) break;
					const archivedPublic = await fetchArchivedThreads(
						fetchConfig,
						channel.id,
						"public",
						DEFAULT_MAX_THREADS_PER_PARENT,
					);
					indexed += writeFetchFailures(context.source, agentId, failures, archivedPublic.errors, {
						guildId,
						channelId: channel.id,
						phase: "archived_public_threads",
					});
					for (const thread of archivedPublic.data) {
						if (matchesThreadFilter(thread, channelFilter, filteredChannelIds)) threadMap.set(thread.id, thread);
					}
					if (settings.includePrivateArchivedThreads) {
						const archivedPrivate = await fetchArchivedThreads(
							fetchConfig,
							channel.id,
							"private",
							DEFAULT_MAX_THREADS_PER_PARENT,
						);
						indexed += writeFetchFailures(context.source, agentId, failures, archivedPrivate.errors, {
							guildId,
							channelId: channel.id,
							phase: "archived_private_threads",
						});
						for (const thread of archivedPrivate.data) {
							if (matchesThreadFilter(thread, channelFilter, filteredChannelIds)) threadMap.set(thread.id, thread);
						}
					}
				}
			}
			for (const thread of threadMap.values()) {
				if (!context.shouldContinue()) break;
				indexed += writeArtifact(context.source, agentId, channelArtifact(context.source, guild, thread));
				if (settings.includeThreadMembers) {
					const members = await fetchThreadMembers(fetchConfig, thread.id);
					indexed += writeFetchFailures(context.source, agentId, failures, members.errors, {
						guildId,
						threadId: thread.id,
						phase: "thread_members",
					});
					for (const member of members.data) {
						indexed += writeArtifact(context.source, agentId, threadMemberArtifact(guild, thread, member));
					}
				}
			}
		}

		const messageChannels = [...channelRows, ...threadMap.values()].filter(isDiscordTextReadableChannel);
		for (const channel of messageChannels) {
			if (!context.shouldContinue()) break;
			const previousCheckpoint = readDiscordCheckpoint(context.source.id, agentId, guild.id, channel.id);
			const afterCursor = previousCheckpoint?.latestCursor ?? undefined;
			if (afterCursor) incrementalMessageChannelPaths.add(discordChannelPath(guild.id, channel.id));
			const messages = await fetchChannelMessages(
				fetchConfig,
				channel.id,
				settings.maxMessagesPerChannel,
				undefined,
				sinceId,
				afterCursor,
			);
			indexed += writeFetchFailures(context.source, agentId, failures, messages.errors, {
				guildId,
				channelId: channel.id,
				phase: "messages",
			});
			const backfillLimit = Math.max(0, settings.maxMessagesPerChannel - messages.data.length);
			const backfillCursor = previousCheckpoint?.backfillComplete
				? undefined
				: (previousCheckpoint?.backfillCursor ?? previousCheckpoint?.latestCursor ?? undefined);
			const backfill =
				previousCheckpoint && backfillCursor && backfillLimit > 0
					? await fetchChannelMessages(fetchConfig, channel.id, backfillLimit, backfillCursor, sinceId)
					: null;
			if (backfill) {
				indexed += writeFetchFailures(context.source, agentId, failures, backfill.errors, {
					guildId,
					channelId: channel.id,
					phase: "message_backfill",
				});
			}
			const channelMessages = [...messages.data, ...(backfill?.data ?? [])];
			indexed += writeMessageArtifacts(context.source, agentId, guild, channel, channelMessages, {
				includeAttachments: settings.includeAttachments,
				includeEmbeds: settings.includeEmbeds,
				includePolls: settings.includePolls,
			});
			indexed += writeArtifact(
				context.source,
				agentId,
				checkpointArtifact(
					context.source,
					guild,
					channel,
					channelMessages,
					messages.errors.length === 0 && (backfill?.errors.length ?? 0) === 0 ? "authoritative" : "partial",
					previousCheckpoint,
					{
						backfillMessages: backfill?.data ?? (previousCheckpoint ? [] : messages.data),
						backfillComplete:
							backfill !== null
								? backfill.exhausted === true || backfill.reachedLowerBound === true
								: previousCheckpoint
									? previousCheckpoint.backfillComplete
									: messages.exhausted === true || messages.reachedLowerBound === true,
					},
				),
			);
			context.onProgress?.({
				scanned,
				total,
				indexed,
				currentPath: `discord://guild/${guild.id}/channel/${channel.id}`,
			});
		}

		scanned++;
		context.onProgress?.({ scanned, total, indexed, currentPath: `discord://guild/${guild.id}` });
	}

	if (failures.length === 0 && scanned === total) {
		purgeStaleDiscordArtifacts(context.source.id, agentId, syncStartedAt, {
			preserveMessageChannelPaths: [...incrementalMessageChannelPaths],
		});
	}

	return { indexed, scanned, total, failures };
}

async function syncDiscordGatewayTailSource(
	context: SourceProviderSyncContext,
	agentId: string,
	token: string,
	guildIds: readonly string[],
): Promise<SourceProviderSyncResult> {
	const failures: SourceFailureState[] = [];
	let indexed = 0;
	const total = guildIds.length;
	const result = await syncDiscordGatewayTail({
		source: context.source,
		token,
		guildIds,
		shouldContinue: context.shouldContinue,
		onProgress: context.onProgress,
		recordFailure: (message, metadata, recoverable) => {
			const failure = failureState(context.source, message, metadata, recoverable);
			failures.push(failure);
			writeFailureArtifact(context.source, agentId, failure);
			indexed++;
		},
		recordMessage: (guildId, channelId, messageId, message, gatewayEventType, sequence, payload) => {
			if (message) {
				const guild = gatewayGuild(guildId);
				const channel = gatewayChannel(guildId, channelId);
				indexed += writeArtifact(context.source, agentId, messageArtifact(guild, channel, message));
				if (message.mentions && message.mentions.length > 0)
					indexed += writeArtifact(context.source, agentId, mentionArtifact(guild, channel, message));
				for (const attachment of message.attachments ?? []) {
					indexed += writeArtifact(context.source, agentId, attachmentArtifact(guild, channel, message, attachment));
				}
				for (let index = 0; index < (message.embeds ?? []).length; index++) {
					const embed = message.embeds?.[index];
					if (embed)
						indexed += writeArtifact(context.source, agentId, embedArtifact(guild, channel, message, embed, index));
				}
				if (message.poll) indexed += writeArtifact(context.source, agentId, pollArtifact(guild, channel, message));
			} else if (gatewayEventType === "MESSAGE_UPDATE") {
				const patched = patchedMessageArtifact(context.source, agentId, guildId, channelId, messageId, payload);
				if (patched) indexed += writeArtifact(context.source, agentId, patched);
				purgeClearedPartialUpdateArtifacts(context.source, agentId, guildId, channelId, messageId, payload);
			}
			indexed += writeArtifact(
				context.source,
				agentId,
				messageEventArtifact(context.source, guildId, channelId, messageId, gatewayEventType, sequence, payload),
			);
			if (message)
				indexed += writeArtifact(
					context.source,
					agentId,
					gatewayCheckpointArtifact(context.source, guildId, channelId, message.id, gatewayEventType),
				);
		},
		recordMessageDelete: (guildId, channelId, messageId, sequence, payload) => {
			indexed += writeArtifact(
				context.source,
				agentId,
				messageTombstoneArtifact(guildId, channelId, messageId, sequence, payload),
			);
			indexed += writeArtifact(
				context.source,
				agentId,
				messageEventArtifact(context.source, guildId, channelId, messageId, "MESSAGE_DELETE", sequence, payload),
			);
			indexed += writeArtifact(
				context.source,
				agentId,
				gatewayCheckpointArtifact(context.source, guildId, channelId, messageId, "MESSAGE_DELETE"),
			);
		},
		recordChannel: (guildId, channel) => {
			indexed += writeArtifact(
				context.source,
				agentId,
				channelArtifact(context.source, gatewayGuild(guildId), channel),
			);
		},
		recordMember: (guildId, member) => {
			indexed += writeArtifact(context.source, agentId, memberArtifact(gatewayGuild(guildId), member));
		},
		recordMemberRemove: (guildId, userId, sequence, payload) => {
			indexed += writeArtifact(
				context.source,
				agentId,
				memberEventArtifact(guildId, userId, "remove", sequence, payload),
			);
		},
	});
	return { indexed, scanned: result.indexedEvents, total, failures: result.canceled ? [] : failures };
}

function writeArtifact(source: SignetSourceEntry, agentId: string, artifact: DiscordArtifact): number {
	indexExternalMemoryArtifact({
		agentId,
		harness: DISCORD_HARNESS,
		sourceId: source.id,
		sourceRoot: source.root,
		sourceExternalId: artifact.externalId,
		sourceParentPath: artifact.parentPath,
		sourcePath: artifact.path,
		sourceKind: artifact.kind,
		sourceMtimeMs: artifact.mtimeMs,
		content: artifact.content,
		sourceMeta: artifact.meta,
	});
	if (indexesSourceArtifactGraph(artifact)) {
		indexSourceArtifactStructure({
			agentId,
			sourceId: source.id,
			sourceKind: artifact.kind,
			sourceRoot: source.root,
			sourceParentPath: artifact.parentPath,
			sourcePath: artifact.path,
			displayName: sourceArtifactDisplayName(artifact),
			content: artifact.content,
		});
	}
	return 1;
}

function indexesSourceArtifactGraph(artifact: DiscordArtifact): boolean {
	return artifact.kind !== "source_discord_failure" && artifact.kind !== "source_discord_checkpoint";
}

function sourceArtifactDisplayName(artifact: DiscordArtifact): string | undefined {
	const name = artifact.meta.name ?? artifact.meta.username ?? artifact.meta.filename ?? artifact.meta.title;
	return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
}

function writeMessageArtifacts(
	source: SignetSourceEntry,
	agentId: string,
	guild: DiscordGuild,
	channel: DiscordChannel,
	messages: readonly DiscordMessage[],
	options: { readonly includeAttachments: boolean; readonly includeEmbeds: boolean; readonly includePolls: boolean },
): number {
	if (messages.length === 0) return 0;
	let indexed = writeArtifact(source, agentId, messageWindowArtifact(guild, channel, messages));
	for (const msg of messages) {
		indexed += writeArtifact(source, agentId, messageArtifact(guild, channel, msg));
		if (msg.mentions && msg.mentions.length > 0)
			indexed += writeArtifact(source, agentId, mentionArtifact(guild, channel, msg));
		if (options.includeAttachments) {
			for (const attachment of msg.attachments ?? []) {
				indexed += writeArtifact(source, agentId, attachmentArtifact(guild, channel, msg, attachment));
			}
		}
		if (options.includeEmbeds) {
			for (let index = 0; index < (msg.embeds ?? []).length; index++) {
				const embed = msg.embeds?.[index];
				if (embed) indexed += writeArtifact(source, agentId, embedArtifact(guild, channel, msg, embed, index));
			}
		}
		if (options.includePolls && msg.poll) indexed += writeArtifact(source, agentId, pollArtifact(guild, channel, msg));
	}
	return indexed;
}

function writeFetchFailures(
	source: SignetSourceEntry,
	agentId: string,
	failures: SourceFailureState[],
	errors: readonly DiscordFetchError[],
	meta: Readonly<Record<string, unknown>>,
): number {
	let indexed = 0;
	for (const error of errors) {
		const failure = failureState(source, error.message, { ...meta, status: error.status }, error.retryable);
		failures.push(failure);
		writeFailureArtifact(source, agentId, failure);
		indexed++;
	}
	return indexed;
}

function writeFailureArtifact(source: SignetSourceEntry, agentId: string, failure: SourceFailureState): void {
	writeArtifact(source, agentId, {
		kind: "source_discord_failure",
		externalId: `failure:${hashKey(failure.message)}:${failure.failedAt}`,
		path: `discord://source/${source.id}/failure/${hashKey(failure.message)}`,
		mtimeMs: Date.parse(failure.failedAt),
		content: ["# Discord Source Failure", "", failure.message, "", `recoverable: ${failure.recoverable}`].join("\n"),
		meta: { ...failure.metadata, provider: DISCORD_PROVIDER_KIND, recoverable: failure.recoverable },
	});
}

function purgeStaleDiscordArtifacts(
	sourceId: string,
	agentId: string,
	syncStartedAt: string,
	options: { readonly preserveMessageChannelPaths?: readonly string[] } = {},
): number {
	const preservePaths = options.preserveMessageChannelPaths ?? [];
	const preserveClause =
		preservePaths.length > 0
			? `AND NOT (
						 source_kind IN (${DISCORD_MESSAGE_HISTORY_KINDS.map(() => "?").join(", ")})
						 AND (${preservePaths.map(() => "(source_path LIKE ? OR source_path LIKE ?)").join(" OR ")})
					   )`
			: "";
	const params =
		preservePaths.length > 0
			? [
					agentId,
					sourceId,
					syncStartedAt,
					...DISCORD_MESSAGE_HISTORY_KINDS,
					...preservePaths.flatMap((path) => [`${path}/messages/%`, `${path}/message/%`]),
				]
			: [agentId, sourceId, syncStartedAt];
	const rows = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT source_path FROM memory_artifacts
					 WHERE agent_id = ?
					   AND source_id = ?
					   AND updated_at < ?
					   ${preserveClause}`,
				)
				.all(...params) as Array<{ source_path: string }>,
	);
	for (const row of rows) purgeSourceArtifactStructure({ agentId, sourceId, sourcePath: row.source_path });
	return getDbAccessor().withWriteTx((db) =>
		countChanges(
			db
				.prepare(
					`DELETE FROM memory_artifacts
					 WHERE agent_id = ?
					   AND source_id = ?
					   AND updated_at < ?
					   ${preserveClause}`,
				)
				.run(...params),
		),
	);
}

function discordChannelPath(guildId: string, channelId: string): string {
	return `discord://guild/${guildId}/channel/${channelId}`;
}

interface DiscordArtifact {
	readonly kind: string;
	readonly externalId: string;
	readonly path: string;
	readonly parentPath?: string;
	readonly mtimeMs: number;
	readonly content: string;
	readonly meta: Readonly<Record<string, unknown>>;
}

interface DiscordCheckpoint {
	readonly latestCursor: string | null;
	readonly backfillCursor: string | null;
	readonly backfillComplete: boolean;
}

function readDiscordCheckpoint(
	sourceId: string,
	agentId: string,
	guildId: string,
	channelId: string,
): DiscordCheckpoint | null {
	const row = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT source_meta_json FROM memory_artifacts
					 WHERE agent_id = ?
					   AND source_id = ?
					   AND source_kind = 'source_discord_checkpoint'
					   AND source_path = ?
					 LIMIT 1`,
				)
				.get(agentId, sourceId, `discord://source/${sourceId}/checkpoint/${guildId}/${channelId}`) as
				| { source_meta_json: string | null }
				| undefined,
	);
	if (!row?.source_meta_json) return null;
	try {
		const raw = JSON.parse(row.source_meta_json) as unknown;
		if (!isRecord(raw)) return null;
		return {
			latestCursor: cleanCheckpointCursor(raw.latestCursor),
			backfillCursor: cleanCheckpointCursor(raw.backfillCursor),
			backfillComplete: raw.backfillComplete === true,
		};
	} catch {
		return null;
	}
}

function cleanCheckpointCursor(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return parseDiscordSnowflake(trimmed) === null ? null : trimmed;
}

function guildArtifact(source: SignetSourceEntry, guild: DiscordGuild): DiscordArtifact {
	return {
		kind: "source_discord_guild",
		externalId: `guild:${guild.id}`,
		path: `discord://guild/${guild.id}`,
		mtimeMs: Date.now(),
		content: [
			`# Discord Guild: ${guild.name}`,
			"",
			guild.description ? `Description: ${guild.description}` : "",
			`Source: ${source.name}`,
		]
			.filter(Boolean)
			.join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			recordType: "guild",
			guildId: guild.id,
			icon: guild.icon ?? null,
			approximateMemberCount: guild.approximate_member_count ?? null,
			approximatePresenceCount: guild.approximate_presence_count ?? null,
		},
	};
}

function channelArtifact(source: SignetSourceEntry, guild: DiscordGuild, channel: DiscordChannel): DiscordArtifact {
	const parentPath = channel.parent_id
		? `discord://guild/${guild.id}/channel/${channel.parent_id}`
		: `discord://guild/${guild.id}`;
	const label = isDiscordThread(channel)
		? "Thread"
		: channel.type === DISCORD_CHANNEL_TYPES.guildCategory
			? "Category"
			: "Channel";
	return {
		kind: isDiscordThread(channel) ? "source_discord_thread" : "source_discord_channel",
		externalId: `${isDiscordThread(channel) ? "thread" : "channel"}:${channel.id}`,
		path: `discord://guild/${guild.id}/channel/${channel.id}`,
		parentPath,
		mtimeMs: Date.now(),
		content: [
			`# Discord ${label}: ${channel.name ?? channel.id}`,
			"",
			`Guild: ${guild.name}`,
			`Type: ${channel.type}`,
			channel.topic ? `Topic: ${channel.topic}` : "",
			`Source: ${source.name}`,
		]
			.filter(Boolean)
			.join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			recordType: isDiscordThread(channel) ? "thread" : "channel",
			guildId: guild.id,
			channelId: channel.id,
			parentId: channel.parent_id ?? null,
			channelType: channel.type,
			threadMetadata: channel.thread_metadata ?? null,
		},
	};
}

function memberArtifact(guild: DiscordGuild, member: DiscordGuildMember): DiscordArtifact {
	const user = member.user;
	const userId = user?.id ?? hashKey(JSON.stringify(member));
	return {
		kind: "source_discord_member",
		externalId: `member:${guild.id}:${userId}`,
		path: `discord://guild/${guild.id}/member/${userId}`,
		parentPath: `discord://guild/${guild.id}`,
		mtimeMs: Date.parse(member.joined_at ?? "") || Date.now(),
		content: [
			`# Discord Member: ${user ? discordDisplayName(user) : userId}`,
			"",
			`Guild: ${guild.name}`,
			member.nick ? `Nickname: ${member.nick}` : "",
			`Bot: ${user?.bot === true}`,
		]
			.filter(Boolean)
			.join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			recordType: "member",
			guildId: guild.id,
			userId,
			roles: member.roles ?? [],
		},
	};
}

function threadMemberArtifact(
	guild: DiscordGuild,
	thread: DiscordChannel,
	member: { readonly id?: string; readonly user_id?: string },
): DiscordArtifact {
	const userId = member.user_id ?? member.id ?? hashKey(JSON.stringify(member));
	return {
		kind: "source_discord_thread_member",
		externalId: `thread_member:${thread.id}:${userId}`,
		path: `discord://guild/${guild.id}/channel/${thread.id}/member/${userId}`,
		parentPath: `discord://guild/${guild.id}/channel/${thread.id}`,
		mtimeMs: Date.now(),
		content: [
			"# Discord Thread Member",
			"",
			`Guild: ${guild.name}`,
			`Thread: ${thread.name ?? thread.id}`,
			`User: ${userId}`,
		].join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			recordType: "thread_member",
			guildId: guild.id,
			threadId: thread.id,
			userId,
		},
	};
}

function messageWindowArtifact(
	guild: DiscordGuild,
	channel: DiscordChannel,
	messages: readonly DiscordMessage[],
): DiscordArtifact {
	const sorted = messages.slice().sort(compareDiscordMessagesByCursor);
	const oldest = sorted[0];
	const newest = sorted[sorted.length - 1];
	const windowKey = `${oldest?.id ?? "empty"}-${newest?.id ?? "empty"}`;
	return {
		kind: "source_discord_message_window",
		externalId: `message_window:${channel.id}:${windowKey}`,
		path: `discord://guild/${guild.id}/channel/${channel.id}/messages/${windowKey}`,
		parentPath: `discord://guild/${guild.id}/channel/${channel.id}`,
		mtimeMs: Date.parse(newest?.timestamp ?? "") || Date.now(),
		content: messagesToMarkdown(guild, channel, messages),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			recordType: "message_window",
			guildId: guild.id,
			channelId: channel.id,
			messageCount: messages.length,
			oldestMessageId: oldest?.id ?? null,
			newestMessageId: newest?.id ?? null,
		},
	};
}

function messageArtifact(guild: DiscordGuild, channel: DiscordChannel, msg: DiscordMessage): DiscordArtifact {
	const speaker = discordDisplayName(msg.author);
	return {
		kind: "source_discord_message",
		externalId: `message:${msg.id}`,
		path: `discord://guild/${guild.id}/channel/${channel.id}/messages/${msg.id}`,
		parentPath: `discord://guild/${guild.id}/channel/${channel.id}`,
		mtimeMs: Date.parse(msg.edited_timestamp ?? msg.timestamp) || Date.now(),
		content: [
			`# Discord Message: ${msg.id}`,
			"",
			`Guild: ${guild.name}`,
			`Channel: ${channel.name ?? channel.id}`,
			`Author: ${speaker} (${msg.author.id})`,
			`Created: ${msg.timestamp}`,
			msg.edited_timestamp ? `Edited: ${msg.edited_timestamp}` : "",
			msg.message_reference?.message_id ? `Reply to: ${msg.message_reference.message_id}` : "",
			msg.pinned ? "Pinned: true" : "",
			"",
			msg.content,
		]
			.filter(Boolean)
			.join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			recordType: "message",
			guildId: guild.id,
			channelId: channel.id,
			messageId: msg.id,
			messageType: msg.type,
			authorId: msg.author.id,
			authorName: speaker,
			createdAt: msg.timestamp,
			editedAt: msg.edited_timestamp ?? null,
			replyToMessageId: msg.message_reference?.message_id ?? msg.referenced_message?.id ?? null,
			replyToChannelId: msg.message_reference?.channel_id ?? null,
			pinned: msg.pinned === true,
			flags: msg.flags ?? null,
			webhookId: msg.webhook_id ?? null,
			attachmentIds: (msg.attachments ?? []).map((attachment) => attachment.id),
			mentionUserIds: (msg.mentions ?? []).map((user) => user.id),
			mentionRoleIds: msg.mention_roles ?? [],
			embedCount: msg.embeds?.length ?? 0,
			pollPresent: !!msg.poll,
			reactions: (msg.reactions ?? []).map((reaction) => ({
				count: reaction.count ?? 0,
				emojiId: reaction.emoji?.id ?? null,
				emojiName: reaction.emoji?.name ?? null,
			})),
		},
	};
}

function patchedMessageArtifact(
	source: SignetSourceEntry,
	agentId: string,
	guildId: string,
	channelId: string,
	messageId: string,
	payload: unknown,
): DiscordArtifact | null {
	if (!isRecord(payload)) return null;
	const row = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT content, source_meta_json
					 FROM memory_artifacts
					 WHERE agent_id = ?
					   AND source_id = ?
					   AND source_kind = 'source_discord_message'
					   AND source_path = ?
					 LIMIT 1`,
				)
				.get(agentId, source.id, `discord://guild/${guildId}/channel/${channelId}/messages/${messageId}`) as
				| { content: string; source_meta_json: string | null }
				| undefined,
	);
	if (!row) return null;
	const meta = parseMetaJson(row.source_meta_json);
	const editedAt = readPayloadString(payload, "edited_timestamp") ?? readMetaString(meta, "editedAt");
	const pinned = typeof payload.pinned === "boolean" ? payload.pinned : null;
	const content = patchMessageContent(row.content, {
		content: readPayloadString(payload, "content"),
		editedAt,
		meta,
		pinned,
	});
	return {
		kind: "source_discord_message",
		externalId: `message:${messageId}`,
		path: `discord://guild/${guildId}/channel/${channelId}/messages/${messageId}`,
		parentPath: `discord://guild/${guildId}/channel/${channelId}`,
		mtimeMs: Date.parse(editedAt ?? "") || Date.now(),
		content,
		meta: {
			...meta,
			provider: DISCORD_PROVIDER_KIND,
			recordType: "message",
			guildId,
			channelId,
			messageId,
			editedAt: editedAt ?? null,
			...(typeof payload.pinned === "boolean" ? { pinned: payload.pinned } : {}),
			...(typeof payload.flags === "number" ? { flags: payload.flags } : {}),
			...(Array.isArray(payload.attachments)
				? { attachmentIds: payload.attachments.map(discordPayloadId).filter(isNonNullString) }
				: {}),
			...(Array.isArray(payload.mentions)
				? { mentionUserIds: payload.mentions.map(discordPayloadId).filter(isNonNullString) }
				: {}),
			...(Array.isArray(payload.mention_roles) ? { mentionRoleIds: payload.mention_roles.filter(isString) } : {}),
			...(Array.isArray(payload.embeds) ? { embedCount: payload.embeds.length } : {}),
			...(hasOwn(payload, "poll") ? { pollPresent: isRecord(payload.poll) } : {}),
			...(Array.isArray(payload.reactions) ? { reactions: payload.reactions.map(discordPayloadReaction) } : {}),
		},
	};
}

function purgeClearedPartialUpdateArtifacts(
	source: SignetSourceEntry,
	agentId: string,
	guildId: string,
	channelId: string,
	messageId: string,
	payload: unknown,
): number {
	if (!isRecord(payload)) return 0;
	const clearedKinds: string[] = [];
	if (hasOwn(payload, "poll") && !isRecord(payload.poll)) clearedKinds.push("source_discord_poll");
	if (Array.isArray(payload.attachments) && payload.attachments.length === 0)
		clearedKinds.push("source_discord_attachment");
	if (Array.isArray(payload.embeds) && payload.embeds.length === 0) clearedKinds.push("source_discord_embed");
	const mentions = Array.isArray(payload.mentions) ? payload.mentions : null;
	const mentionRoles = Array.isArray(payload.mention_roles) ? payload.mention_roles : null;
	if (
		(mentions !== null || mentionRoles !== null) &&
		!(mentions && mentions.length > 0) &&
		!(mentionRoles && mentionRoles.length > 0)
	)
		clearedKinds.push("source_discord_mention");
	if (clearedKinds.length === 0) return 0;
	const sourceParentPath = `discord://guild/${guildId}/channel/${channelId}/messages/${messageId}`;
	const placeholders = clearedKinds.map(() => "?").join(", ");
	const params = [agentId, source.id, sourceParentPath, ...clearedKinds];
	const rows = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT source_path FROM memory_artifacts
					 WHERE agent_id = ?
					   AND source_id = ?
					   AND source_parent_path = ?
					   AND source_kind IN (${placeholders})`,
				)
				.all(...params) as Array<{ source_path: string }>,
	);
	for (const row of rows) purgeSourceArtifactStructure({ agentId, sourceId: source.id, sourcePath: row.source_path });
	return getDbAccessor().withWriteTx((db) =>
		countChanges(
			db
				.prepare(
					`DELETE FROM memory_artifacts
					 WHERE agent_id = ?
					   AND source_id = ?
					   AND source_parent_path = ?
					   AND source_kind IN (${placeholders})`,
				)
				.run(...params),
		),
	);
}

function patchMessageContent(
	previous: string,
	patch: {
		readonly content: string | null;
		readonly editedAt: string | null;
		readonly meta: Readonly<Record<string, unknown>>;
		readonly pinned: boolean | null;
	},
): string {
	const lines = previous.split("\n");
	if (patch.editedAt) {
		const editedIndex = lines.findIndex((line) => line.startsWith("Edited: "));
		if (editedIndex >= 0) lines[editedIndex] = `Edited: ${patch.editedAt}`;
		else {
			const createdIndex = lines.findIndex((line) => line.startsWith("Created: "));
			lines.splice(createdIndex >= 0 ? createdIndex + 1 : Math.min(lines.length, 6), 0, `Edited: ${patch.editedAt}`);
		}
	}
	if (patch.pinned === false) {
		const pinnedIndex = lines.indexOf("Pinned: true");
		if (pinnedIndex >= 0) lines.splice(pinnedIndex, 1);
	} else if (patch.pinned === true && !lines.includes("Pinned: true")) {
		const replyIndex = lines.findIndex((line) => line.startsWith("Reply to: "));
		const editedIndex = lines.findIndex((line) => line.startsWith("Edited: "));
		const createdIndex = lines.findIndex((line) => line.startsWith("Created: "));
		lines.splice(
			replyIndex >= 0 ? replyIndex + 1 : editedIndex >= 0 ? editedIndex + 1 : createdIndex >= 0 ? createdIndex + 1 : 0,
			0,
			"Pinned: true",
		);
	}
	if (patch.content === null) return lines.join("\n");
	const bodyStart = messageBodyStartIndex(lines, {
		...patch.meta,
		editedAt: patch.editedAt,
		...(patch.pinned === null ? {} : { pinned: patch.pinned }),
	});
	return [...lines.slice(0, bodyStart), patch.content].join("\n");
}

function messageBodyStartIndex(lines: readonly string[], meta: Readonly<Record<string, unknown>>): number {
	let index = consumeLine(lines, 0, "# Discord Message: ");
	index = consumeBlankLine(lines, index);
	index = consumeLine(lines, index, "Guild: ");
	index = consumeLine(lines, index, "Channel: ");
	index = consumeLine(lines, index, "Author: ");
	index = consumeLine(lines, index, "Created: ");
	if (readMetaString(meta, "editedAt")) index = consumeLine(lines, index, "Edited: ");
	if (readMetaString(meta, "replyToMessageId")) index = consumeLine(lines, index, "Reply to: ");
	if (meta.pinned === true) index = consumeExactLine(lines, index, "Pinned: true");
	index = consumeBlankLine(lines, index);
	return index;
}

function consumeLine(lines: readonly string[], index: number, prefix: string): number {
	return (lines[index] ?? "").startsWith(prefix) ? index + 1 : index;
}

function consumeExactLine(lines: readonly string[], index: number, expected: string): number {
	return lines[index] === expected ? index + 1 : index;
}

function consumeBlankLine(lines: readonly string[], index: number): number {
	return lines[index] === "" ? index + 1 : index;
}

function hasOwn(record: Readonly<Record<string, unknown>>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(record, key);
}

function mentionArtifact(guild: DiscordGuild, channel: DiscordChannel, msg: DiscordMessage): DiscordArtifact {
	return {
		kind: "source_discord_mention",
		externalId: `mention:${msg.id}`,
		path: `discord://guild/${guild.id}/channel/${channel.id}/message/${msg.id}/mentions`,
		parentPath: `discord://guild/${guild.id}/channel/${channel.id}/messages/${msg.id}`,
		mtimeMs: Date.parse(msg.timestamp) || Date.now(),
		content: [
			"# Discord Mentions",
			"",
			`Guild: ${guild.name}`,
			`Channel: ${channel.name ?? channel.id}`,
			`Message: ${msg.id}`,
			`Mentions: ${(msg.mentions ?? []).map((user) => `${discordDisplayName(user)} (${user.id})`).join(", ")}`,
			`Role Mentions: ${(msg.mention_roles ?? []).join(", ")}`,
		].join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			recordType: "mention",
			guildId: guild.id,
			channelId: channel.id,
			messageId: msg.id,
			userIds: (msg.mentions ?? []).map((user) => user.id),
			roleIds: msg.mention_roles ?? [],
		},
	};
}

function attachmentArtifact(
	guild: DiscordGuild,
	channel: DiscordChannel,
	msg: DiscordMessage,
	attachment: DiscordAttachment,
): DiscordArtifact {
	return {
		kind: "source_discord_attachment",
		externalId: `attachment:${attachment.id}`,
		path: `discord://guild/${guild.id}/channel/${channel.id}/message/${msg.id}/attachment/${attachment.id}`,
		parentPath: `discord://guild/${guild.id}/channel/${channel.id}/messages/${msg.id}`,
		mtimeMs: Date.parse(msg.timestamp) || Date.now(),
		content: [
			`# Discord Attachment: ${attachment.filename}`,
			"",
			`Guild: ${guild.name}`,
			`Channel: ${channel.name ?? channel.id}`,
			`Message: ${msg.id}`,
			`Size: ${attachment.size}`,
			attachment.content_type ? `Content-Type: ${attachment.content_type}` : "",
			attachment.description ? `Description: ${attachment.description}` : "",
		]
			.filter(Boolean)
			.join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			recordType: "attachment",
			guildId: guild.id,
			channelId: channel.id,
			messageId: msg.id,
			attachmentId: attachment.id,
			filename: attachment.filename,
			size: attachment.size,
			contentType: attachment.content_type ?? null,
			width: attachment.width ?? null,
			height: attachment.height ?? null,
			urlPresent: !!attachment.url,
			proxyUrlPresent: !!attachment.proxy_url,
		},
	};
}

function embedArtifact(
	guild: DiscordGuild,
	channel: DiscordChannel,
	msg: DiscordMessage,
	embed: DiscordEmbed,
	index: number,
): DiscordArtifact {
	return {
		kind: "source_discord_embed",
		externalId: `embed:${msg.id}:${index}`,
		path: `discord://guild/${guild.id}/channel/${channel.id}/message/${msg.id}/embed/${index}`,
		parentPath: `discord://guild/${guild.id}/channel/${channel.id}/messages/${msg.id}`,
		mtimeMs: Date.parse(msg.timestamp) || Date.now(),
		content: [
			"# Discord Embed",
			"",
			embed.title ? `Title: ${embed.title}` : "",
			embed.description ? `Description: ${embed.description}` : "",
			...(embed.fields ?? []).map((field) => `${field.name}: ${field.value}`),
		]
			.filter(Boolean)
			.join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			recordType: "embed",
			guildId: guild.id,
			channelId: channel.id,
			messageId: msg.id,
			index,
		},
	};
}

function pollArtifact(guild: DiscordGuild, channel: DiscordChannel, msg: DiscordMessage): DiscordArtifact {
	return {
		kind: "source_discord_poll",
		externalId: `poll:${msg.id}`,
		path: `discord://guild/${guild.id}/channel/${channel.id}/message/${msg.id}/poll`,
		parentPath: `discord://guild/${guild.id}/channel/${channel.id}/messages/${msg.id}`,
		mtimeMs: Date.parse(msg.timestamp) || Date.now(),
		content: [
			"# Discord Poll",
			"",
			`Question: ${msg.poll?.question?.text ?? ""}`,
			...(msg.poll?.answers ?? []).map((answer) => `- ${answer.poll_media?.text ?? answer.answer_id ?? ""}`),
		].join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			recordType: "poll",
			guildId: guild.id,
			channelId: channel.id,
			messageId: msg.id,
		},
	};
}

function messageEventArtifact(
	source: SignetSourceEntry,
	guildId: string,
	channelId: string,
	messageId: string,
	gatewayEventType: string,
	sequence: number | null,
	payload: unknown,
): DiscordArtifact {
	const eventType = gatewayEventType.replace(/^MESSAGE_/, "").toLowerCase();
	const eventKey = sequence === null ? hashKey(JSON.stringify(payload)) : String(sequence);
	return {
		kind: "source_discord_message_event",
		externalId: `message_event:${gatewayEventType}:${messageId}:${eventKey}`,
		path: `discord://guild/${guildId}/channel/${channelId}/message/${messageId}/event/${eventKey}`,
		parentPath: `discord://guild/${guildId}/channel/${channelId}/messages/${messageId}`,
		mtimeMs: Date.now(),
		content: [
			"# Discord Message Event",
			"",
			`Source: ${source.name}`,
			`Guild: ${guildId}`,
			`Channel: ${channelId}`,
			`Message: ${messageId}`,
			`Event: ${eventType}`,
		].join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			recordType: "message_event",
			guildId,
			channelId,
			messageId,
			eventType,
			gatewayEventType,
			sequence,
			payload: compactGatewayPayload(payload),
		},
	};
}

function messageTombstoneArtifact(
	guildId: string,
	channelId: string,
	messageId: string,
	sequence: number | null,
	payload: unknown,
): DiscordArtifact {
	return {
		kind: "source_discord_message_tombstone",
		externalId: `message_tombstone:${messageId}`,
		path: `discord://guild/${guildId}/channel/${channelId}/messages/${messageId}/deleted`,
		parentPath: `discord://guild/${guildId}/channel/${channelId}/messages/${messageId}`,
		mtimeMs: Date.now(),
		content: [
			"# Discord Deleted Message",
			"",
			`Guild: ${guildId}`,
			`Channel: ${channelId}`,
			`Message: ${messageId}`,
			"Deleted: true",
		].join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			recordType: "message_tombstone",
			guildId,
			channelId,
			messageId,
			deleted: true,
			sequence,
			payload: compactGatewayPayload(payload),
		},
	};
}

function memberEventArtifact(
	guildId: string,
	userId: string,
	eventType: "remove",
	sequence: number | null,
	payload: unknown,
): DiscordArtifact {
	return {
		kind: "source_discord_member_event",
		externalId: `member_event:${guildId}:${userId}:${eventType}:${sequence ?? hashKey(JSON.stringify(payload))}`,
		path: `discord://guild/${guildId}/member/${userId}/event/${sequence ?? "unknown"}`,
		parentPath: `discord://guild/${guildId}/member/${userId}`,
		mtimeMs: Date.now(),
		content: ["# Discord Member Event", "", `Guild: ${guildId}`, `User: ${userId}`, `Event: ${eventType}`].join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			recordType: "member_event",
			guildId,
			userId,
			eventType,
			sequence,
			payload: compactGatewayPayload(payload),
		},
	};
}

function gatewayCheckpointArtifact(
	source: SignetSourceEntry,
	guildId: string,
	channelId: string,
	messageId: string,
	gatewayEventType: string,
): DiscordArtifact {
	return {
		kind: "source_discord_checkpoint",
		externalId: `checkpoint:gateway:${guildId}:${channelId}`,
		path: `discord://source/${source.id}/checkpoint/gateway/${guildId}/${channelId}`,
		parentPath: `discord://guild/${guildId}/channel/${channelId}`,
		mtimeMs: Date.now(),
		content: [
			"# Discord Gateway Checkpoint",
			"",
			`Guild: ${guildId}`,
			`Channel: ${channelId}`,
			`Latest event: ${gatewayEventType}`,
			`Latest cursor: ${messageId}`,
		].join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			recordType: "checkpoint",
			syncMode: "gateway-tail",
			guildId,
			channelId,
			status: "tailing",
			latestCursor: messageId,
			backfillCursor: null,
			backfillComplete: false,
			gatewayEventType,
		},
	};
}

function checkpointArtifact(
	source: SignetSourceEntry,
	guild: DiscordGuild,
	channel: DiscordChannel,
	messages: readonly DiscordMessage[],
	status: "authoritative" | "partial",
	previous?: DiscordCheckpoint | null,
	backfillUpdate: {
		readonly backfillMessages: readonly DiscordMessage[];
		readonly backfillComplete: boolean;
	} = { backfillMessages: [], backfillComplete: false },
): DiscordArtifact {
	const sorted = messages.slice().sort(compareDiscordMessagesByCursor);
	const latest = sorted[sorted.length - 1];
	const sortedBackfill = backfillUpdate.backfillMessages.slice().sort(compareDiscordMessagesByCursor);
	const earliestBackfill = sortedBackfill[0];
	const latestCursor = newestCheckpointCursor(previous?.latestCursor ?? null, latest?.id ?? null);
	const backfillCursor = earliestBackfill?.id ?? previous?.backfillCursor ?? null;
	return {
		kind: "source_discord_checkpoint",
		externalId: `checkpoint:${channel.id}`,
		path: `discord://source/${source.id}/checkpoint/${guild.id}/${channel.id}`,
		parentPath: `discord://guild/${guild.id}/channel/${channel.id}`,
		mtimeMs: Date.now(),
		content: [
			"# Discord Checkpoint",
			"",
			`Guild: ${guild.name}`,
			`Channel: ${channel.name ?? channel.id}`,
			`Status: ${status}`,
			`Latest cursor: ${latestCursor ?? ""}`,
			`Backfill cursor: ${backfillCursor ?? ""}`,
		].join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			recordType: "checkpoint",
			guildId: guild.id,
			channelId: channel.id,
			status,
			latestCursor,
			backfillCursor,
			backfillComplete: backfillUpdate.backfillComplete,
		},
	};
}

function newestCheckpointCursor(left: string | null, right: string | null): string | null {
	if (!left) return right;
	if (!right) return left;
	const leftId = parseDiscordSnowflake(left);
	const rightId = parseDiscordSnowflake(right);
	if (leftId !== null && rightId !== null) return leftId > rightId ? left : right;
	return left > right ? left : right;
}

function compareDiscordMessagesByCursor(left: DiscordMessage, right: DiscordMessage): number {
	const leftId = parseDiscordSnowflake(left.id);
	const rightId = parseDiscordSnowflake(right.id);
	if (leftId !== null && rightId !== null) {
		if (leftId < rightId) return -1;
		if (leftId > rightId) return 1;
		return 0;
	}
	const byTimestamp = left.timestamp.localeCompare(right.timestamp);
	if (byTimestamp !== 0) return byTimestamp;
	return left.id.localeCompare(right.id);
}

function parseDiscordSnowflake(value: string): bigint | null {
	try {
		return BigInt(value);
	} catch {
		return null;
	}
}

function gatewayGuild(guildId: string): DiscordGuild {
	return { id: guildId, name: guildId };
}

function gatewayChannel(guildId: string, channelId: string): DiscordChannel {
	return { id: channelId, guild_id: guildId, type: DISCORD_CHANNEL_TYPES.guildText, name: channelId };
}

function compactGatewayPayload(payload: unknown): unknown {
	if (!isRecord(payload)) return payload;
	const compact: Record<string, unknown> = {};
	for (const key of [
		"id",
		"guild_id",
		"channel_id",
		"type",
		"timestamp",
		"edited_timestamp",
		"author",
		"user",
		"message_reference",
	]) {
		if (key in payload) compact[key] = payload[key];
	}
	return compact;
}

function failureState(
	source: SignetSourceEntry,
	message: string,
	metadata: Readonly<Record<string, unknown>>,
	recoverable = true,
): SourceFailureState {
	return {
		sourceId: source.id,
		providerKind: DISCORD_PROVIDER_KIND,
		failedAt: new Date().toISOString(),
		recoverable,
		message,
		metadata,
	};
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function messagesToMarkdown(guild: DiscordGuild, channel: DiscordChannel, messages: readonly DiscordMessage[]): string {
	const lines = [
		`# Discord Messages: ${guild.name} / ${channel.name ?? channel.id}`,
		"",
		`Messages: ${messages.length}`,
		"",
	];
	for (const msg of messages.slice().sort((a, b) => a.timestamp.localeCompare(b.timestamp))) {
		const speaker = discordDisplayName(msg.author);
		const prefix = msg.message_reference ? `${speaker} (replying)` : speaker;
		lines.push(`[${msg.timestamp}] ${prefix}: ${msg.content}`);
		if (msg.edited_timestamp) lines.push(`  Edited: ${msg.edited_timestamp}`);
		if (msg.referenced_message?.id) lines.push(`  Reply to: ${msg.referenced_message.id}`);
		if ((msg.attachments ?? []).length > 0)
			lines.push(`  Attachments: ${(msg.attachments ?? []).map((attachment) => attachment.filename).join(", ")}`);
		if ((msg.embeds ?? []).length > 0) lines.push(`  Embeds: ${msg.embeds?.length ?? 0}`);
		if (msg.poll?.question?.text) lines.push(`  Poll: ${msg.poll.question.text}`);
	}
	return lines.join("\n");
}

function applyChannelFilter(
	channels: readonly DiscordChannel[],
	channelFilter: ReadonlySet<string> | null,
): readonly DiscordChannel[] {
	if (!channelFilter) return channels;
	return channels.filter(
		(channel) => channelFilter.has(channel.id.toLowerCase()) || channelFilter.has((channel.name ?? "").toLowerCase()),
	);
}

function buildChannelFilter(channelFilter: readonly string[] | undefined): ReadonlySet<string> | null {
	if (!channelFilter || channelFilter.length === 0) return null;
	return new Set(channelFilter.map((entry) => entry.toLowerCase()));
}

function matchesThreadFilter(
	thread: DiscordChannel,
	channelFilter: ReadonlySet<string> | null,
	filteredChannelIds: ReadonlySet<string>,
): boolean {
	if (!channelFilter) return true;
	if (channelFilter.has(thread.id.toLowerCase()) || channelFilter.has((thread.name ?? "").toLowerCase())) return true;
	return Boolean(thread.parent_id && filteredChannelIds.has(thread.parent_id));
}

function isThreadParent(channel: DiscordChannel): boolean {
	return (
		channel.type === DISCORD_CHANNEL_TYPES.guildText ||
		channel.type === DISCORD_CHANNEL_TYPES.guildAnnouncement ||
		channel.type === DISCORD_CHANNEL_TYPES.guildForum ||
		channel.type === DISCORD_CHANNEL_TYPES.guildMedia
	);
}

function hashKey(input: string): string {
	let hash = 0;
	for (let index = 0; index < input.length; index++) {
		hash = (hash * 31 + input.charCodeAt(index)) >>> 0;
	}
	return hash.toString(16).padStart(8, "0");
}

function parseMetaJson(value: string | null): Record<string, unknown> {
	if (!value) return {};
	try {
		const parsed = JSON.parse(value) as unknown;
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function readMetaString(meta: Readonly<Record<string, unknown>>, key: string): string | null {
	const value = meta[key];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function readPayloadString(payload: Readonly<Record<string, unknown>>, key: string): string | null {
	const value = payload[key];
	return typeof value === "string" ? value : null;
}

function discordPayloadId(value: unknown): string | null {
	return isRecord(value) ? readPayloadString(value, "id") : null;
}

function discordPayloadReaction(value: unknown): Record<string, unknown> {
	if (!isRecord(value)) return {};
	const emoji = isRecord(value.emoji)
		? {
				emojiId: readPayloadString(value.emoji, "id"),
				emojiName: readPayloadString(value.emoji, "name"),
			}
		: {};
	return { count: typeof value.count === "number" ? value.count : 0, ...emoji };
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isNonNullString(value: string | null): value is string {
	return value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
