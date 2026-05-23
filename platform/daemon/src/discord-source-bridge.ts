import type { DiscordSourceSettings, SignetSourceEntry } from "@signet/core";
import { parseDiscordSettings } from "@signet/core";
import { resolveDaemonAgentId } from "./agent-id";
import { yieldEvery } from "./async-yield";
import { indexDiscordSourceEmbeddings, purgeDiscordSourceEmbeddings } from "./discord-source-embeddings";
import {
	type DiscordChannel,
	type DiscordFetchConfig,
	type DiscordMessage,
	fetchActiveThreads,
	fetchChannelMessages,
	fetchGuild,
	fetchGuildChannels,
	fetchPublicArchivedThreads,
	isTextChannel,
	isThread,
	snowflakeIdForTimestamp,
} from "./discord-source-fetch";
import {
	indexDiscordSourceStructure,
	purgeDiscordSourceStructure,
	reconcileDiscordGuildStructure,
} from "./discord-source-graph";
import { logger } from "./logger";
import type { EmbeddingConfig } from "./memory-config";
import type { SourceEmbeddingFetch } from "./obsidian-source-embeddings";
import { getSecret } from "./secrets.js";

export interface DiscordSourceBridgeHandle {
	readonly sync: () => Promise<number>;
	readonly close: () => Promise<void>;
}

export interface DiscordSourceBridgeOptions {
	readonly agentId?: string;
	readonly pollIntervalMs?: number;
	readonly embeddingConfig?: EmbeddingConfig;
	readonly fetchEmbedding?: SourceEmbeddingFetch;
	readonly agentsDir?: string;
	readonly sourceActiveCheck?: () => boolean;
}

export interface DiscordSourceSyncResult {
	readonly indexed: number;
	readonly syncedGuilds: number;
}

interface DiscordParticipant {
	readonly id: string;
	readonly name: string;
}

async function resolveToken(tokenRef: string, agentsDir?: string): Promise<string | undefined> {
	try {
		return await getSecret(tokenRef);
	} catch (err) {
		logger.warn("discord-source", "Failed to resolve Discord bot token from secret", {
			tokenRef,
			error: err instanceof Error ? err.message : String(err),
		});
		return undefined;
	}
}

export async function syncDiscordSource(
	source: SignetSourceEntry,
	options: DiscordSourceBridgeOptions = {},
): Promise<DiscordSourceSyncResult> {
	const agentId = options.agentId ?? resolveDaemonAgentId();
	const settings = parseDiscordSettings(source.settings);
	const token = settings.tokenRef ? await resolveToken(settings.tokenRef, options.agentsDir) : undefined;
	if (!token) {
		logger.warn("discord-source", "No Discord bot token available, skipping source", { sourceId: source.id });
		return { indexed: 0, syncedGuilds: 0 };
	}
	const isSourceActive = options.sourceActiveCheck ?? (() => true);
	if (!isSourceActive()) return { indexed: 0, syncedGuilds: 0 };

	const config: DiscordFetchConfig = { token };
	const sinceId = settings.since ? snowflakeIdForTimestamp(settings.since) : undefined;
	let totalIndexed = 0;
	let syncedGuilds = 0;

	logger.info("discord-source", "Starting Discord source sync", {
		sourceId: source.id,
		guildCount: settings.guildIds.length,
	});

	for (const guildId of settings.guildIds) {
		if (!isSourceActive()) break;
		let guildName: string;
		try {
			const guild = await fetchGuild(config, guildId);
			if (!guild) {
				logger.warn("discord-source", "Guild not found or bot lacks access", { guildId });
				continue;
			}
			guildName = guild.name;
			syncedGuilds++;
		} catch (err) {
			logger.warn("discord-source", "Failed to fetch guild info", {
				guildId,
				error: err instanceof Error ? err.message : String(err),
			});
			continue;
		}

		const channelsResult = await fetchGuildChannels(config, guildId);
		if (channelsResult.errors.length > 0) {
			for (const e of channelsResult.errors) {
				logger.warn("discord-source", "Channel fetch error", { guildId, error: e.message });
			}
		}

		const textChannels = channelsResult.data.filter((ch) => isTextChannel(ch) && !isThread(ch));
		const channelFilter = settings.channelFilter ? new Set(settings.channelFilter) : null;
		const filteredChannels = channelFilter
			? textChannels.filter((ch) => channelFilter.has(ch.id) || (ch.name && channelFilter.has(ch.name)))
			: textChannels;
		const activeThreads = settings.includeThreads ? await fetchGuildActiveThreads(config, guildId) : [];
		const currentChannelIds = filteredChannels.map((channel) => channel.id);
		const reconciledChannels: Array<{ channelId: string; conversationPaths: string[] }> = [];

		const yielder = yieldEvery(5);

		for (const channel of filteredChannels) {
			if (!isSourceActive()) break;
			const channelName = channel.name ?? channel.id;
			try {
				const conversationPaths: string[] = [];
				const msgResult = await fetchChannelMessages(
					config,
					channel.id,
					settings.maxMessagesPerChannel,
					undefined,
					sinceId,
				);
				if (msgResult.data.length > 0) {
					if (!isSourceActive()) break;
					const participants = extractParticipants(msgResult.data);
					indexDiscordSourceStructure({
						agentId,
						sourceId: source.id,
						sourceName: source.name,
						guildId,
						guildName,
						channelId: channel.id,
						channelName,
						messageCount: msgResult.data.length,
						participants,
					});
					conversationPaths.push(`discord:${source.id}:guild:${guildId}:channel:${channel.id}:messages`);
					totalIndexed++;
				}
				if (options.embeddingConfig && options.fetchEmbedding) {
					await indexDiscordSourceEmbeddings({
						agentId,
						sourceId: source.id,
						guildId,
						channelId: channel.id,
						channelName,
						messages: msgResult.data,
						embeddingConfig: options.embeddingConfig,
						fetchEmbedding: options.fetchEmbedding,
					});
				}

				if (settings.includeThreads) {
					const threadResult = await syncThreads(
						config,
						source,
						settings,
						guildId,
						guildName,
						channel.id,
						channelName,
						agentId,
						options,
						sinceId,
						activeThreads,
					);
					totalIndexed += threadResult.indexed;
					conversationPaths.push(...threadResult.conversationPaths);
				}
				reconciledChannels.push({ channelId: channel.id, conversationPaths });

				await yielder();
			} catch (err) {
				logger.warn("discord-source", "Failed to sync channel", {
					guildId,
					channelId: channel.id,
					channelName,
					error: err instanceof Error ? err.message : String(err),
				});
			}
		}
		reconcileDiscordGuildStructure({
			agentId,
			sourceId: source.id,
			guildId,
			currentChannelIds,
			reconciledChannels,
		});

		logger.info("discord-source", "Guild sync complete", {
			sourceId: source.id,
			guildId,
			guildName,
			channels: filteredChannels.length,
		});
	}

	return { indexed: totalIndexed, syncedGuilds };
}

async function syncThreads(
	config: DiscordFetchConfig,
	source: SignetSourceEntry,
	settings: DiscordSourceSettings,
	guildId: string,
	guildName: string,
	parentChannelId: string,
	parentChannelName: string,
	agentId: string,
	options: DiscordSourceBridgeOptions,
	sinceId: string | undefined,
	activeThreads: readonly DiscordChannel[],
): Promise<{ indexed: number; conversationPaths: string[] }> {
	let indexed = 0;
	const conversationPaths: string[] = [];
	const isSourceActive = options.sourceActiveCheck ?? (() => true);

	const archivedResult = await fetchPublicArchivedThreads(config, parentChannelId, 50);
	const allThreads = [
		...activeThreads.filter((thread) => thread.parent_id === parentChannelId),
		...archivedResult.data,
	];
	const seen = new Set<string>();
	const uniqueThreads = allThreads.filter((t) => {
		if (seen.has(t.id)) return false;
		seen.add(t.id);
		return true;
	});

	for (const thread of uniqueThreads) {
		if (!isSourceActive()) break;
		try {
			const threadName = thread.name ?? thread.id;
			const msgResult = await fetchChannelMessages(
				config,
				thread.id,
				settings.maxMessagesPerChannel,
				undefined,
				sinceId,
			);
			if (msgResult.data.length > 0) {
				if (!isSourceActive()) break;
				const participants = extractParticipants(msgResult.data);
				indexDiscordSourceStructure({
					agentId,
					sourceId: source.id,
					sourceName: source.name,
					guildId,
					guildName,
					channelId: parentChannelId,
					channelName: parentChannelName,
					threadId: thread.id,
					threadName,
					messageCount: msgResult.data.length,
					participants,
				});
				conversationPaths.push(`discord:${source.id}:guild:${guildId}:channel:${parentChannelId}:thread:${thread.id}`);
				indexed++;
			}
			if (options.embeddingConfig && options.fetchEmbedding) {
				await indexDiscordSourceEmbeddings({
					agentId,
					sourceId: source.id,
					guildId,
					channelId: parentChannelId,
					channelName: parentChannelName,
					threadId: thread.id,
					messages: msgResult.data,
					embeddingConfig: options.embeddingConfig,
					fetchEmbedding: options.fetchEmbedding,
				});
			}
		} catch (err) {
			logger.warn("discord-source", "Failed to sync thread", {
				threadId: thread.id,
				error: err instanceof Error ? err.message : String(err),
			});
		}
	}

	return { indexed, conversationPaths };
}

async function fetchGuildActiveThreads(
	config: DiscordFetchConfig,
	guildId: string,
): Promise<readonly DiscordChannel[]> {
	const activeResult = await fetchActiveThreads(config, guildId);
	for (const error of activeResult.errors) {
		logger.warn("discord-source", "Active thread fetch error", { guildId, error: error.message });
	}
	return activeResult.data;
}

function extractParticipants(messages: readonly DiscordMessage[]): DiscordParticipant[] {
	const seen = new Map<string, DiscordParticipant>();
	for (const msg of messages) {
		if (msg.author && !msg.author.bot) {
			const name = msg.author.global_name ?? msg.author.username;
			if (msg.author.id && name && !seen.has(msg.author.id)) {
				seen.set(msg.author.id, { id: msg.author.id, name });
			}
		}
	}
	return [...seen.values()];
}

export function purgeDiscordSource(sourceId: string, agentId?: string): number {
	const emb = purgeDiscordSourceEmbeddings({ sourceId, agentId });
	const graph = purgeDiscordSourceStructure({ sourceId, agentId });
	return emb + graph;
}
