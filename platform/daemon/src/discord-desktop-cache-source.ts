import { type Stats, existsSync, lstatSync, readFileSync, readdirSync } from "node:fs";
import { basename, join, relative } from "node:path";
import { gunzipSync } from "node:zlib";
import type { SignetSourceEntry } from "@signet/core";
import { getDbAccessor } from "./db-accessor";
import { countChanges } from "./db-helpers";
import { indexExternalMemoryArtifact } from "./memory-lineage";
import { indexSourceArtifactStructure, purgeSourceArtifactStructure } from "./source-artifact-graph";
import type { SourceProviderSyncResult } from "./source-providers";

const DISCORD_PROVIDER_KIND = "discord";
const DISCORD_HARNESS = "discord";
const DIRECT_MESSAGE_GUILD_ID = "@me";
const DIRECT_MESSAGE_GUILD_NAME = "Discord Direct Messages";
const MAX_FILE_BYTES = 64 << 20;
const MAX_OBJECT_BYTES = 4 << 20;
const CACHE_SNIFF_BYTES = 1 << 20;

const channelRoutePattern = /\/channels\/(@me|[0-9]{12,24})\/([0-9]{12,24})/g;
const apiMessagesRoutePattern = /\/api\/v[0-9]+\/channels\/[0-9]{12,24}\/messages/;
const discordTokenLikePattern =
	/(mfa\.[A-Za-z0-9_-]{20,}|[A-Za-z0-9_-]{20,32}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{20,})/g;
const sensitiveFieldNamePattern = /\b(auth(?:orization)?|api[_ -]?key|cookie|password|secret|token)\b/i;

export interface DiscordDesktopCacheSyncOptions {
	readonly source: SignetSourceEntry;
	readonly agentId: string;
	readonly cachePath: string;
	readonly fullScan: boolean;
	readonly shouldContinue: () => boolean;
	readonly onProgress?: (event: {
		readonly scanned: number;
		readonly total: number;
		readonly indexed: number;
		readonly currentPath: string;
	}) => void;
}

interface CacheCandidate {
	readonly absPath: string;
	readonly relPath: string;
	readonly source: "context" | "cache";
	readonly size: number;
	readonly mtimeMs: number;
}

interface CacheStats {
	filesVisited: number;
	filesScanned: number;
	filesSkipped: number;
	cacheFilesFastSkipped: number;
	bytesScanned: number;
	jsonObjects: number;
	guilds: number;
	channels: number;
	messages: number;
	dmMessages: number;
	dmChannels: number;
	guildMessages: number;
	skippedMessages: number;
	skippedChannels: number;
}

interface CacheSnapshot {
	readonly guilds: Map<string, CacheGuild>;
	readonly channels: Map<string, CacheChannel>;
	readonly messages: Map<string, CacheMessage>;
	readonly routes: Map<string, string>;
	readonly userLabels: Map<string, UserLabel>;
}

interface CacheGuild {
	readonly id: string;
	readonly name: string;
}

interface CacheChannel {
	readonly id: string;
	readonly guildId: string;
	readonly name: string;
	readonly kind: string;
	readonly synthetic?: boolean;
}

interface CacheMessage {
	readonly id: string;
	readonly guildId: string;
	readonly channelId: string;
	readonly channelName: string;
	readonly authorId: string;
	readonly authorName: string;
	readonly type: number;
	readonly createdAt: string;
	readonly editedAt?: string;
	readonly content: string;
	readonly replyToMessageId?: string;
	readonly pinned: boolean;
	readonly attachments: readonly CacheAttachment[];
	readonly mentions: readonly CacheMention[];
	readonly embeds: readonly CacheEmbed[];
	readonly poll?: CachePoll;
	readonly routeAmbiguous?: boolean;
}

interface CacheAttachment {
	readonly id: string;
	readonly filename: string;
	readonly size: number;
	readonly contentType?: string;
	readonly width?: number;
	readonly height?: number;
	readonly urlPresent: boolean;
	readonly proxyUrlPresent: boolean;
}

interface CacheMention {
	readonly id: string;
	readonly name: string;
}

interface CacheEmbed {
	readonly title?: string;
	readonly description?: string;
	readonly fields: readonly { readonly name: string; readonly value: string }[];
}

interface CachePoll {
	readonly question: string;
	readonly answers: readonly string[];
}

interface UserLabel {
	readonly name: string;
	readonly priority: number;
}

interface CacheArtifact {
	readonly kind: string;
	readonly externalId: string;
	readonly path: string;
	readonly parentPath?: string;
	readonly mtimeMs: number;
	readonly content: string;
	readonly meta: Readonly<Record<string, unknown>>;
}

export async function syncDiscordDesktopCacheSource(
	options: DiscordDesktopCacheSyncOptions,
): Promise<SourceProviderSyncResult> {
	const syncStartedAt = new Date().toISOString();
	const stats = emptyStats();
	const snapshot = emptySnapshot();
	const root = options.cachePath;
	const candidates = discoverCandidates(root, options.fullScan, stats);
	let indexed = 0;
	let cancelled = false;

	for (const candidate of candidates) {
		if (!options.shouldContinue()) {
			cancelled = true;
			break;
		}
		const data = readCandidateFile(candidate, stats);
		if (!data) continue;
		stats.filesScanned++;
		stats.bytesScanned += data.length;
		collectTextPayload(snapshot, data.toString("utf8"), candidate.mtimeMs, stats);
		for (const payload of extractGzipPayloads(data)) {
			collectTextPayload(snapshot, payload.toString("utf8"), candidate.mtimeMs, stats);
		}
		options.onProgress?.({
			scanned: stats.filesScanned,
			total: candidates.length,
			indexed,
			currentPath: candidate.relPath,
		});
	}

	finalizeSnapshot(snapshot, stats);
	for (const artifact of artifactsForSnapshot(options.source, snapshot, stats, root, options.fullScan)) {
		if (!options.shouldContinue()) {
			cancelled = true;
			break;
		}
		writeArtifact(options.source, options.agentId, artifact);
		indexed++;
	}
	if (!cancelled) purgeStaleDesktopCacheArtifacts(options.source.id, options.agentId, syncStartedAt);

	return { indexed, scanned: stats.filesScanned, total: candidates.length, failures: [] };
}

function discoverCandidates(root: string, fullScan: boolean, stats: CacheStats): readonly CacheCandidate[] {
	if (!existsSync(root)) return [];
	const candidates: CacheCandidate[] = [];
	const visit = (path: string): void => {
		let stat: Stats;
		try {
			stat = lstatSync(path);
		} catch {
			stats.filesSkipped++;
			return;
		}
		if (stat.isDirectory()) {
			if (path !== root && shouldSkipDir(basename(path))) return;
			for (const entry of readDirectoryEntries(path, stats)) visit(join(path, entry));
			return;
		}
		stats.filesVisited++;
		if (!stat.isFile() || stat.size <= 0 || stat.size > MAX_FILE_BYTES || !isCandidateFile(path)) {
			stats.filesSkipped++;
			return;
		}
		const source = isRouteFilteredCachePath(root, path) ? "cache" : "context";
		if (source === "cache" && !fullScan && !cacheFileHasRouteHint(path)) {
			stats.filesSkipped++;
			stats.cacheFilesFastSkipped++;
			return;
		}
		candidates.push({
			absPath: path,
			relPath: relative(root, path) || basename(path),
			source,
			size: stat.size,
			mtimeMs: stat.mtimeMs,
		});
	};
	visit(root);
	return candidates;
}

function readDirectoryEntries(path: string, stats: CacheStats): readonly string[] {
	try {
		return readdirSync(path);
	} catch {
		stats.filesSkipped++;
		return [];
	}
}

function readCandidateFile(candidate: CacheCandidate, stats: CacheStats): Buffer | null {
	try {
		return readFileSync(candidate.absPath);
	} catch {
		stats.filesSkipped++;
		return null;
	}
}

function collectTextPayload(snapshot: CacheSnapshot, text: string, fallbackMtimeMs: number, stats: CacheStats): void {
	const routes = collectChannelRoutes(text);
	mergeChannelRoutes(snapshot.routes, routes);
	const values = extractJSONValues(text);
	stats.jsonObjects += values.length;
	for (const value of values) collectValue(snapshot, value, fallbackMtimeMs, routes);
	mergeChannelRoutes(snapshot.routes, routes);
}

function collectValue(
	snapshot: CacheSnapshot,
	value: unknown,
	fallbackMtimeMs: number,
	routes: Map<string, string>,
): void {
	if (Array.isArray(value)) {
		for (const child of value) collectValue(snapshot, child, fallbackMtimeMs, routes);
		return;
	}
	if (!isRecord(value)) return;
	collectUserLabel(snapshot, value);
	collectSelectedDirectMessageRoutes(routes, value);
	const channel = parseChannel(value);
	if (channel) snapshot.channels.set(channel.id, channel);
	const message = parseMessage(value, fallbackMtimeMs, snapshot.channels, routes);
	if (message) snapshot.messages.set(message.id, message);
	for (const child of Object.values(value)) collectValue(snapshot, child, fallbackMtimeMs, routes);
}

function finalizeSnapshot(snapshot: CacheSnapshot, stats: CacheStats): void {
	reconcileMessages(snapshot);
	inferDirectMessageNames(snapshot);
	reconcileMessages(snapshot);
	const skippedChannelIds = new Set<string>();
	for (const [id, message] of snapshot.messages) {
		if (!message.guildId) {
			stats.skippedMessages++;
			skippedChannelIds.add(message.channelId);
			snapshot.messages.delete(id);
			continue;
		}
		if (!snapshot.guilds.has(message.guildId)) snapshot.guilds.set(message.guildId, syntheticGuild(message.guildId));
		if (!snapshot.channels.has(message.channelId)) {
			snapshot.channels.set(
				message.channelId,
				syntheticChannel(message.channelId, message.guildId, message.channelName),
			);
		}
	}
	const dmChannels = new Set<string>();
	for (const message of snapshot.messages.values()) {
		stats.messages++;
		if (message.guildId === DIRECT_MESSAGE_GUILD_ID) {
			stats.dmMessages++;
			dmChannels.add(message.channelId);
		} else {
			stats.guildMessages++;
		}
	}
	stats.dmChannels = dmChannels.size;
	stats.skippedChannels = skippedChannelIds.size;
	stats.channels = snapshot.channels.size;
	stats.guilds = snapshot.guilds.size;
}

function reconcileMessages(snapshot: CacheSnapshot): void {
	for (const [id, message] of snapshot.messages) {
		const channel = snapshot.channels.get(message.channelId);
		const usableChannel = message.routeAmbiguous && channel?.synthetic ? undefined : channel;
		const routedGuildId = message.routeAmbiguous ? "" : snapshot.routes.get(message.channelId);
		const guildId = usableChannel?.guildId || routedGuildId || message.guildId;
		if (!guildId) {
			snapshot.messages.set(id, message);
			continue;
		}
		const channelName = usableChannel?.name || message.channelName || `channel-${shortId(message.channelId)}`;
		snapshot.messages.set(id, { ...message, guildId, channelName });
		if (!channel) snapshot.channels.set(message.channelId, syntheticChannel(message.channelId, guildId, channelName));
	}
}

function inferDirectMessageNames(snapshot: CacheSnapshot): void {
	const authorChannels = new Map<string, Set<string>>();
	const channelAuthors = new Map<string, Map<string, number>>();
	for (const message of snapshot.messages.values()) {
		const label = snapshot.userLabels.get(message.authorId);
		if (label && shouldUseUserLabel(message.authorName, label)) {
			snapshot.messages.set(message.id, { ...message, authorName: label.name });
		}
		if (message.guildId !== DIRECT_MESSAGE_GUILD_ID || !message.authorId) continue;
		if (!authorChannels.has(message.authorId)) authorChannels.set(message.authorId, new Set());
		authorChannels.get(message.authorId)?.add(message.channelId);
		const counts = channelAuthors.get(message.channelId) ?? new Map<string, number>();
		counts.set(message.authorId, (counts.get(message.authorId) ?? 0) + 1);
		channelAuthors.set(message.channelId, counts);
	}
	const selfId = mostRepeatedDirectMessageAuthor(authorChannels);
	for (const [id, channel] of snapshot.channels) {
		if (channel.guildId !== DIRECT_MESSAGE_GUILD_ID || !isFallbackChannelName(channel.name, id)) continue;
		const name = directMessageChannelName(channelAuthors.get(id) ?? new Map(), snapshot.userLabels, selfId);
		if (name) snapshot.channels.set(id, { ...channel, name });
	}
}

function artifactsForSnapshot(
	source: SignetSourceEntry,
	snapshot: CacheSnapshot,
	stats: CacheStats,
	root: string,
	fullScan: boolean,
): readonly CacheArtifact[] {
	const artifacts: CacheArtifact[] = [importStatsArtifact(source, stats, root, fullScan)];
	for (const guild of [...snapshot.guilds.values()].sort((left, right) => left.id.localeCompare(right.id))) {
		artifacts.push(guildArtifact(source, guild));
	}
	for (const channel of [...snapshot.channels.values()].sort((left, right) => left.id.localeCompare(right.id))) {
		artifacts.push(channelArtifact(source, channel));
	}
	const messages = [...snapshot.messages.values()].sort(compareMessages);
	const byChannel = new Map<string, CacheMessage[]>();
	for (const message of messages)
		byChannel.set(message.channelId, [...(byChannel.get(message.channelId) ?? []), message]);
	for (const [channelId, channelMessages] of byChannel) {
		const channel = snapshot.channels.get(channelId);
		const guild = channel ? snapshot.guilds.get(channel.guildId) : undefined;
		if (channel && guild) artifacts.push(messageWindowArtifact(guild, channel, channelMessages));
	}
	for (const message of messages) {
		const channel = snapshot.channels.get(message.channelId);
		const guild = channel ? snapshot.guilds.get(channel.guildId) : undefined;
		if (!channel || !guild) continue;
		artifacts.push(messageArtifact(guild, channel, message));
		if (message.mentions.length > 0) artifacts.push(mentionArtifact(guild, channel, message));
		for (const attachment of message.attachments)
			artifacts.push(attachmentArtifact(guild, channel, message, attachment));
		for (let index = 0; index < message.embeds.length; index++) {
			const embed = message.embeds[index];
			if (embed) artifacts.push(embedArtifact(guild, channel, message, embed, index));
		}
		if (message.poll) artifacts.push(pollArtifact(guild, channel, message));
	}
	for (const [channelId, channelMessages] of byChannel) {
		const channel = snapshot.channels.get(channelId);
		const guild = channel ? snapshot.guilds.get(channel.guildId) : undefined;
		if (channel && guild) artifacts.push(checkpointArtifact(source, guild, channel, channelMessages));
	}
	return artifacts;
}

function writeArtifact(source: SignetSourceEntry, agentId: string, artifact: CacheArtifact): void {
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
	if (artifact.kind !== "source_discord_checkpoint") {
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
}

function sourceArtifactDisplayName(artifact: CacheArtifact): string | undefined {
	const name = artifact.meta.name ?? artifact.meta.username ?? artifact.meta.filename ?? artifact.meta.title;
	return typeof name === "string" && name.trim().length > 0 ? name.trim() : undefined;
}

function purgeStaleDesktopCacheArtifacts(sourceId: string, agentId: string, syncStartedAt: string): number {
	const rows = getDbAccessor().withReadDb(
		(db) =>
			db
				.prepare(
					`SELECT source_path FROM memory_artifacts
					 WHERE agent_id = ?
					   AND source_id = ?
					   AND updated_at < ?`,
				)
				.all(agentId, sourceId, syncStartedAt) as Array<{ source_path: string }>,
	);
	for (const row of rows) purgeSourceArtifactStructure({ agentId, sourceId, sourcePath: row.source_path });
	return getDbAccessor().withWriteTx((db) =>
		countChanges(
			db
				.prepare(
					`DELETE FROM memory_artifacts
					 WHERE agent_id = ?
					   AND source_id = ?
					   AND updated_at < ?`,
				)
				.run(agentId, sourceId, syncStartedAt),
		),
	);
}

function importStatsArtifact(
	source: SignetSourceEntry,
	stats: CacheStats,
	root: string,
	fullScan: boolean,
): CacheArtifact {
	return {
		kind: "source_discord_desktop_import",
		externalId: "desktop-cache-import",
		path: `discord-cache://source/${source.id}/import`,
		mtimeMs: Date.now(),
		content: [
			"# Discord Desktop Cache Import",
			"",
			`Path: ${root}`,
			`Full cache scan: ${fullScan}`,
			`Messages: ${stats.messages}`,
			`DM messages: ${stats.dmMessages}`,
			`Skipped messages: ${stats.skippedMessages}`,
		].join("\n"),
		meta: { provider: DISCORD_PROVIDER_KIND, origin: "desktop-cache", recordType: "import", ...stats, fullScan },
	};
}

function guildArtifact(source: SignetSourceEntry, guild: CacheGuild): CacheArtifact {
	return {
		kind: "source_discord_guild",
		externalId: `desktop_guild:${guild.id}`,
		path: `discord-cache://guild/${guild.id}`,
		mtimeMs: Date.now(),
		content: [`# Discord Desktop Guild: ${guild.name}`, "", `Source: ${source.name}`].join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			origin: "desktop-cache",
			recordType: "guild",
			guildId: guild.id,
			localOnly: guild.id === DIRECT_MESSAGE_GUILD_ID,
		},
	};
}

function channelArtifact(source: SignetSourceEntry, channel: CacheChannel): CacheArtifact {
	return {
		kind: "source_discord_channel",
		externalId: `desktop_channel:${channel.id}`,
		path: `discord-cache://guild/${channel.guildId}/channel/${channel.id}`,
		parentPath: `discord-cache://guild/${channel.guildId}`,
		mtimeMs: Date.now(),
		content: [
			`# Discord Desktop Channel: ${channel.name}`,
			"",
			`Guild: ${guildName(channel.guildId)}`,
			`Kind: ${channel.kind}`,
			`Source: ${source.name}`,
		].join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			origin: "desktop-cache",
			recordType: "channel",
			guildId: channel.guildId,
			channelId: channel.id,
			channelKind: channel.kind,
			localOnly: channel.guildId === DIRECT_MESSAGE_GUILD_ID,
		},
	};
}

function messageWindowArtifact(
	guild: CacheGuild,
	channel: CacheChannel,
	messages: readonly CacheMessage[],
): CacheArtifact {
	const sorted = messages.slice().sort(compareMessages);
	const oldest = sorted[0];
	const newest = sorted[sorted.length - 1];
	const windowKey = `${oldest?.id ?? "empty"}-${newest?.id ?? "empty"}`;
	return {
		kind: "source_discord_message_window",
		externalId: `desktop_message_window:${channel.id}:${windowKey}`,
		path: `discord-cache://guild/${guild.id}/channel/${channel.id}/messages/${windowKey}`,
		parentPath: `discord-cache://guild/${guild.id}/channel/${channel.id}`,
		mtimeMs: Date.parse(newest?.editedAt ?? newest?.createdAt ?? "") || Date.now(),
		content: messagesToMarkdown(guild, channel, sorted),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			origin: "desktop-cache",
			recordType: "message_window",
			guildId: guild.id,
			channelId: channel.id,
			messageCount: messages.length,
			oldestMessageId: oldest?.id ?? null,
			newestMessageId: newest?.id ?? null,
			localOnly: guild.id === DIRECT_MESSAGE_GUILD_ID,
		},
	};
}

function messageArtifact(guild: CacheGuild, channel: CacheChannel, message: CacheMessage): CacheArtifact {
	return {
		kind: "source_discord_message",
		externalId: `desktop_message:${message.id}`,
		path: `discord-cache://guild/${guild.id}/channel/${channel.id}/messages/${message.id}`,
		parentPath: `discord-cache://guild/${guild.id}/channel/${channel.id}`,
		mtimeMs: Date.parse(message.editedAt ?? message.createdAt) || Date.now(),
		content: [
			`# Discord Desktop Message: ${message.id}`,
			"",
			`Guild: ${guild.name}`,
			`Channel: ${channel.name}`,
			`Author: ${message.authorName || message.authorId} (${message.authorId})`,
			`Created: ${message.createdAt}`,
			message.editedAt ? `Edited: ${message.editedAt}` : "",
			message.replyToMessageId ? `Reply to: ${message.replyToMessageId}` : "",
			message.pinned ? "Pinned: true" : "",
			"",
			message.content,
		]
			.filter(Boolean)
			.join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			origin: "desktop-cache",
			recordType: "message",
			guildId: guild.id,
			channelId: channel.id,
			messageId: message.id,
			messageType: message.type,
			authorId: message.authorId,
			authorName: message.authorName,
			createdAt: message.createdAt,
			editedAt: message.editedAt ?? null,
			replyToMessageId: message.replyToMessageId ?? null,
			pinned: message.pinned,
			attachmentIds: message.attachments.map((attachment) => attachment.id),
			mentionUserIds: message.mentions.map((mention) => mention.id),
			embedCount: message.embeds.length,
			pollPresent: !!message.poll,
			localOnly: guild.id === DIRECT_MESSAGE_GUILD_ID,
			rawPayloadStored: false,
		},
	};
}

function mentionArtifact(guild: CacheGuild, channel: CacheChannel, message: CacheMessage): CacheArtifact {
	return {
		kind: "source_discord_mention",
		externalId: `desktop_mention:${message.id}`,
		path: `discord-cache://guild/${guild.id}/channel/${channel.id}/message/${message.id}/mentions`,
		parentPath: `discord-cache://guild/${guild.id}/channel/${channel.id}/messages/${message.id}`,
		mtimeMs: Date.parse(message.createdAt) || Date.now(),
		content: [
			"# Discord Desktop Mentions",
			"",
			`Guild: ${guild.name}`,
			`Channel: ${channel.name}`,
			`Message: ${message.id}`,
			`Mentions: ${message.mentions.map((mention) => `${mention.name || mention.id} (${mention.id})`).join(", ")}`,
		].join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			origin: "desktop-cache",
			recordType: "mention",
			guildId: guild.id,
			channelId: channel.id,
			messageId: message.id,
			userIds: message.mentions.map((mention) => mention.id),
			localOnly: guild.id === DIRECT_MESSAGE_GUILD_ID,
		},
	};
}

function attachmentArtifact(
	guild: CacheGuild,
	channel: CacheChannel,
	message: CacheMessage,
	attachment: CacheAttachment,
): CacheArtifact {
	return {
		kind: "source_discord_attachment",
		externalId: `desktop_attachment:${attachment.id}`,
		path: `discord-cache://guild/${guild.id}/channel/${channel.id}/message/${message.id}/attachment/${attachment.id}`,
		parentPath: `discord-cache://guild/${guild.id}/channel/${channel.id}/messages/${message.id}`,
		mtimeMs: Date.parse(message.createdAt) || Date.now(),
		content: [
			`# Discord Desktop Attachment: ${attachment.filename}`,
			"",
			`Guild: ${guild.name}`,
			`Channel: ${channel.name}`,
			`Message: ${message.id}`,
			`Size: ${attachment.size}`,
			attachment.contentType ? `Content-Type: ${attachment.contentType}` : "",
		]
			.filter(Boolean)
			.join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			origin: "desktop-cache",
			recordType: "attachment",
			guildId: guild.id,
			channelId: channel.id,
			messageId: message.id,
			attachmentId: attachment.id,
			filename: attachment.filename,
			size: attachment.size,
			contentType: attachment.contentType ?? null,
			width: attachment.width ?? null,
			height: attachment.height ?? null,
			urlPresent: attachment.urlPresent,
			proxyUrlPresent: attachment.proxyUrlPresent,
			localOnly: guild.id === DIRECT_MESSAGE_GUILD_ID,
		},
	};
}

function embedArtifact(
	guild: CacheGuild,
	channel: CacheChannel,
	message: CacheMessage,
	embed: CacheEmbed,
	index: number,
): CacheArtifact {
	return {
		kind: "source_discord_embed",
		externalId: `desktop_embed:${message.id}:${index}`,
		path: `discord-cache://guild/${guild.id}/channel/${channel.id}/message/${message.id}/embed/${index}`,
		parentPath: `discord-cache://guild/${guild.id}/channel/${channel.id}/messages/${message.id}`,
		mtimeMs: Date.parse(message.createdAt) || Date.now(),
		content: [
			"# Discord Desktop Embed",
			"",
			embed.title ? `Title: ${embed.title}` : "",
			embed.description ? `Description: ${embed.description}` : "",
			...embed.fields.map((field) => `${field.name}: ${field.value}`),
		]
			.filter(Boolean)
			.join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			origin: "desktop-cache",
			recordType: "embed",
			guildId: guild.id,
			channelId: channel.id,
			messageId: message.id,
			index,
			localOnly: guild.id === DIRECT_MESSAGE_GUILD_ID,
		},
	};
}

function pollArtifact(guild: CacheGuild, channel: CacheChannel, message: CacheMessage): CacheArtifact {
	return {
		kind: "source_discord_poll",
		externalId: `desktop_poll:${message.id}`,
		path: `discord-cache://guild/${guild.id}/channel/${channel.id}/message/${message.id}/poll`,
		parentPath: `discord-cache://guild/${guild.id}/channel/${channel.id}/messages/${message.id}`,
		mtimeMs: Date.parse(message.createdAt) || Date.now(),
		content: [
			"# Discord Desktop Poll",
			"",
			`Question: ${message.poll?.question ?? ""}`,
			...(message.poll?.answers ?? []).map((answer) => `- ${answer}`),
		].join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			origin: "desktop-cache",
			recordType: "poll",
			guildId: guild.id,
			channelId: channel.id,
			messageId: message.id,
			localOnly: guild.id === DIRECT_MESSAGE_GUILD_ID,
		},
	};
}

function checkpointArtifact(
	source: SignetSourceEntry,
	guild: CacheGuild,
	channel: CacheChannel,
	messages: readonly CacheMessage[],
): CacheArtifact {
	const sorted = messages.slice().sort(compareMessages);
	const latest = sorted[sorted.length - 1];
	const earliest = sorted[0];
	return {
		kind: "source_discord_checkpoint",
		externalId: `desktop_checkpoint:${channel.id}`,
		path: `discord-cache://source/${source.id}/checkpoint/${guild.id}/${channel.id}`,
		parentPath: `discord-cache://guild/${guild.id}/channel/${channel.id}`,
		mtimeMs: Date.now(),
		content: [
			"# Discord Desktop Checkpoint",
			"",
			`Guild: ${guild.name}`,
			`Channel: ${channel.name}`,
			"Status: cache-observed",
			`Latest cursor: ${latest?.id ?? ""}`,
			`Backfill cursor: ${earliest?.id ?? ""}`,
		].join("\n"),
		meta: {
			provider: DISCORD_PROVIDER_KIND,
			origin: "desktop-cache",
			recordType: "checkpoint",
			guildId: guild.id,
			channelId: channel.id,
			status: "cache-observed",
			latestCursor: latest?.id ?? null,
			backfillCursor: earliest?.id ?? null,
			localOnly: guild.id === DIRECT_MESSAGE_GUILD_ID,
		},
	};
}

function parseChannel(raw: Readonly<Record<string, unknown>>): CacheChannel | null {
	const id = stringField(raw, "id");
	if (!looksSnowflake(id) || raw.channel_id !== undefined) return null;
	const type = intField(raw, "type");
	const recipients = Array.isArray(raw.recipients) ? raw.recipients : [];
	let guildId = stringField(raw, "guild_id");
	const isDm = !guildId && (type === 1 || type === 3 || recipients.length > 0);
	if (isDm) guildId = DIRECT_MESSAGE_GUILD_ID;
	if (!guildId) return null;
	const recipientName = recipientLabel(recipients);
	const name = firstNonEmpty(
		stringField(raw, "name"),
		recipientName,
		isDm ? `dm-${shortId(id)}` : `channel-${shortId(id)}`,
	);
	return { id, guildId, name, kind: kindForChannelType(type, isDm) };
}

function parseMessage(
	raw: Readonly<Record<string, unknown>>,
	fallbackMtimeMs: number,
	channels: ReadonlyMap<string, CacheChannel>,
	routes: ReadonlyMap<string, string>,
): CacheMessage | null {
	const id = stringField(raw, "id");
	const channelId = stringField(raw, "channel_id");
	if (!looksSnowflake(id) || !looksSnowflake(channelId)) return null;
	const author = recordField(raw, "author");
	const content = typeof raw.content === "string" ? sanitizeCacheText(raw.content.trim()) : "";
	if (!content && !author) return null;
	const createdAt = parseDiscordTime(stringField(raw, "timestamp")) ?? snowflakeTime(id) ?? new Date(fallbackMtimeMs);
	const channel = channels.get(channelId);
	const routeGuildId = routes.get(channelId);
	const guildId = stringField(raw, "guild_id") || channel?.guildId || routeGuildId || "";
	const authorId = author ? stringField(author, "id") : "";
	const authorName = author
		? firstNonEmpty(
				stringField(author, "global_name"),
				stringField(author, "display_name"),
				stringField(author, "username"),
			)
		: "";
	return {
		id,
		guildId,
		channelId,
		channelName: channel?.name ?? `channel-${shortId(channelId)}`,
		authorId,
		authorName,
		type: intField(raw, "type"),
		createdAt: createdAt.toISOString(),
		...(parseDiscordTime(stringField(raw, "edited_timestamp"))
			? { editedAt: parseDiscordTime(stringField(raw, "edited_timestamp"))?.toISOString() }
			: {}),
		content,
		replyToMessageId: messageReferenceId(raw),
		pinned: raw.pinned === true,
		attachments: parseAttachments(raw, id),
		mentions: parseMentions(raw),
		embeds: parseEmbeds(raw),
		...(parsePoll(raw) ? { poll: parsePoll(raw) ?? undefined } : {}),
		...(routes.has(channelId) && !routeGuildId && !guildId ? { routeAmbiguous: true } : {}),
	};
}

function parseAttachments(raw: Readonly<Record<string, unknown>>, messageId: string): readonly CacheAttachment[] {
	const items = Array.isArray(raw.attachments) ? raw.attachments : [];
	return items.flatMap((item, index) => {
		if (!isRecord(item)) return [];
		const id = stringField(item, "id") || `${messageId}:${index}`;
		return [
			{
				id,
				filename: firstNonEmpty(stringField(item, "filename"), id),
				size: intField(item, "size"),
				contentType: stringField(item, "content_type") || undefined,
				width: intField(item, "width") || undefined,
				height: intField(item, "height") || undefined,
				urlPresent: stringField(item, "url").length > 0,
				proxyUrlPresent: stringField(item, "proxy_url").length > 0,
			},
		];
	});
}

function parseMentions(raw: Readonly<Record<string, unknown>>): readonly CacheMention[] {
	const items = Array.isArray(raw.mentions) ? raw.mentions : [];
	return items.flatMap((item) => {
		if (!isRecord(item)) return [];
		const id = stringField(item, "id");
		if (!id) return [];
		return [
			{
				id,
				name: firstNonEmpty(
					stringField(item, "global_name"),
					stringField(item, "display_name"),
					stringField(item, "username"),
				),
			},
		];
	});
}

function parseEmbeds(raw: Readonly<Record<string, unknown>>): readonly CacheEmbed[] {
	const items = Array.isArray(raw.embeds) ? raw.embeds : [];
	return items.flatMap((item) => {
		if (!isRecord(item)) return [];
		const fields = Array.isArray(item.fields)
			? item.fields.flatMap((field) => {
					if (!isRecord(field)) return [];
					const name = sanitizeCacheText(stringField(field, "name"));
					return [{ name, value: sanitizeCacheText(stringField(field, "value"), name) }];
				})
			: [];
		return [
			{
				title: sanitizeCacheText(stringField(item, "title")) || undefined,
				description: sanitizeCacheText(stringField(item, "description")) || undefined,
				fields,
			},
		];
	});
}

function sanitizeCacheText(value: string, fieldName = ""): string {
	if (!value) return "";
	if (fieldName && sensitiveFieldNamePattern.test(fieldName)) return "[redacted]";
	return value.replace(discordTokenLikePattern, "[redacted]");
}

function parsePoll(raw: Readonly<Record<string, unknown>>): CachePoll | null {
	const poll = recordField(raw, "poll");
	if (!poll) return null;
	const question = stringField(recordField(poll, "question") ?? {}, "text");
	const answers = Array.isArray(poll.answers)
		? poll.answers.flatMap((answer) => {
				if (!isRecord(answer)) return [];
				const media = recordField(answer, "poll_media");
				return [stringField(media ?? {}, "text") || String(answer.answer_id ?? "")].filter(Boolean);
			})
		: [];
	return question || answers.length > 0 ? { question, answers } : null;
}

function collectUserLabel(snapshot: CacheSnapshot, raw: Readonly<Record<string, unknown>>): void {
	const id = stringField(raw, "id");
	if (!looksSnowflake(id) || !looksUserObject(raw)) return;
	const label = userObjectLabel(raw);
	if (!label) return;
	const existing = snapshot.userLabels.get(id);
	if (!existing || label.priority > existing.priority || !existing.name) snapshot.userLabels.set(id, label);
}

function collectSelectedDirectMessageRoutes(routes: Map<string, string>, raw: Readonly<Record<string, unknown>>): void {
	for (const candidate of [raw, recordField(raw, "_state"), recordField(raw, "state")].filter(isRecord)) {
		const selected = recordField(candidate, "selectedChannelIds");
		const selectedNull = selected ? stringField(selected, "null") : "";
		if (looksSnowflake(selectedNull)) collectChannelRoute(routes, selectedNull, DIRECT_MESSAGE_GUILD_ID);
		if (candidate.selectedGuildId === null) {
			const channelId = stringField(candidate, "selectedChannelId");
			if (looksSnowflake(channelId)) collectChannelRoute(routes, channelId, DIRECT_MESSAGE_GUILD_ID);
		}
	}
}

function collectChannelRoutes(text: string): Map<string, string> {
	const routes = new Map<string, string>();
	channelRoutePattern.lastIndex = 0;
	for (const match of text.matchAll(channelRoutePattern)) {
		const guildId = match[1];
		const channelId = match[2];
		if (guildId && channelId && looksSnowflake(channelId)) collectChannelRoute(routes, channelId, guildId);
	}
	return routes;
}

function collectChannelRoute(routes: Map<string, string>, channelId: string, guildId: string): void {
	if (routes.has(channelId)) {
		const existing = routes.get(channelId);
		if (existing !== guildId) routes.set(channelId, "");
		return;
	}
	routes.set(channelId, guildId);
}

function mergeChannelRoutes(target: Map<string, string>, source: ReadonlyMap<string, string>): void {
	for (const [channelId, guildId] of source) {
		if (!guildId) {
			target.delete(channelId);
			continue;
		}
		const existing = target.get(channelId);
		if (!existing) target.set(channelId, guildId);
		else if (existing !== guildId) target.delete(channelId);
	}
}

function extractJSONValues(text: string): readonly unknown[] {
	const trimmed = text.trim();
	if (trimmed.length > 0 && Buffer.byteLength(trimmed) <= MAX_OBJECT_BYTES) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (isRecord(parsed) || Array.isArray(parsed)) return [parsed];
		} catch {
			// Fall through to embedded object extraction.
		}
	}
	return extractJSONObjectStrings(text).flatMap((candidate) => {
		try {
			return [JSON.parse(candidate) as unknown];
		} catch {
			return [];
		}
	});
}

function extractJSONObjectStrings(text: string): readonly string[] {
	const out: string[] = [];
	let depth = 0;
	let start = -1;
	let inString = false;
	let escaped = false;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (inString) {
			if (escaped) {
				escaped = false;
				continue;
			}
			if (char === "\\") escaped = true;
			else if (char === '"') inString = false;
			continue;
		}
		if (char === '"' && depth > 0) inString = true;
		else if (char === "{") {
			if (depth === 0) start = index;
			depth++;
		} else if (char === "}" && depth > 0) {
			depth--;
			if (depth === 0 && start >= 0) {
				const candidate = text.slice(start, index + 1).trim();
				if (Buffer.byteLength(candidate) <= MAX_OBJECT_BYTES) out.push(candidate);
				start = -1;
			}
		}
	}
	return out;
}

function extractGzipPayloads(data: Buffer): readonly Buffer[] {
	const out: Buffer[] = [];
	for (let offset = 0; offset < data.length - 1; offset++) {
		if (data[offset] !== 0x1f || data[offset + 1] !== 0x8b) continue;
		try {
			const payload = gunzipSync(data.subarray(offset), { maxOutputLength: MAX_FILE_BYTES });
			if (payload.length <= MAX_FILE_BYTES) out.push(payload);
		} catch {
			// Cache blobs often contain arbitrary binary sequences; ignore invalid gzip offsets.
		}
	}
	return out;
}

function cacheFileHasRouteHint(path: string): boolean {
	try {
		const data = readFileSync(path).subarray(0, CACHE_SNIFF_BYTES).toString("utf8");
		channelRoutePattern.lastIndex = 0;
		return channelRoutePattern.test(data) || apiMessagesRoutePattern.test(data);
	} catch {
		return false;
	}
}

function isRouteFilteredCachePath(root: string, path: string): boolean {
	const cleanRoot = root.replaceAll("\\", "/");
	const cleanPath = path.replaceAll("\\", "/");
	return (
		basename(cleanRoot) === "Cache_Data" ||
		basename(cleanRoot) === "CacheStorage" ||
		cleanPath.includes("/Cache/Cache_Data/") ||
		cleanPath.includes("/Service Worker/CacheStorage/")
	);
}

function shouldSkipDir(name: string): boolean {
	return new Set([
		"blob_storage",
		"component_crx_cache",
		"crashpad",
		"dawngraphitecache",
		"dawnwebgpucache",
		"download_cache",
		"gpucache",
		"gpu-cache",
		"shadercache",
		"spellcheck",
		"videodecodestats",
		"widevinecdm",
	]).has(name.toLowerCase());
}

function isCandidateFile(path: string): boolean {
	const clean = path.replaceAll("\\", "/");
	if (
		clean.includes("/Cache/Cache_Data/") ||
		clean.includes("/Service Worker/CacheStorage/") ||
		clean.includes("/WebStorage/")
	)
		return true;
	return [".ldb", ".log", ".json", ".txt"].some((extension) => path.toLowerCase().endsWith(extension));
}

function messagesToMarkdown(guild: CacheGuild, channel: CacheChannel, messages: readonly CacheMessage[]): string {
	const lines = [`# Discord Desktop Messages: ${guild.name} / ${channel.name}`, "", `Messages: ${messages.length}`, ""];
	for (const message of messages) {
		const prefix = message.replyToMessageId
			? `${message.authorName || message.authorId} (replying)`
			: message.authorName;
		lines.push(`[${message.createdAt}] ${prefix || message.authorId}: ${message.content}`);
		if (message.editedAt) lines.push(`  Edited: ${message.editedAt}`);
		if (message.replyToMessageId) lines.push(`  Reply to: ${message.replyToMessageId}`);
		if (message.attachments.length > 0)
			lines.push(`  Attachments: ${message.attachments.map((attachment) => attachment.filename).join(", ")}`);
		if (message.embeds.length > 0) lines.push(`  Embeds: ${message.embeds.length}`);
		if (message.poll?.question) lines.push(`  Poll: ${message.poll.question}`);
	}
	return lines.join("\n");
}

function emptyStats(): CacheStats {
	return {
		filesVisited: 0,
		filesScanned: 0,
		filesSkipped: 0,
		cacheFilesFastSkipped: 0,
		bytesScanned: 0,
		jsonObjects: 0,
		guilds: 0,
		channels: 0,
		messages: 0,
		dmMessages: 0,
		dmChannels: 0,
		guildMessages: 0,
		skippedMessages: 0,
		skippedChannels: 0,
	};
}

function emptySnapshot(): CacheSnapshot {
	return {
		guilds: new Map(),
		channels: new Map(),
		messages: new Map(),
		routes: new Map(),
		userLabels: new Map(),
	};
}

function syntheticGuild(id: string): CacheGuild {
	return { id, name: guildName(id) };
}

function syntheticChannel(id: string, guildId: string, name: string): CacheChannel {
	const fallbackName = name || (guildId === DIRECT_MESSAGE_GUILD_ID ? `dm-${shortId(id)}` : `channel-${shortId(id)}`);
	return {
		id,
		guildId,
		name: fallbackName,
		kind: guildId === DIRECT_MESSAGE_GUILD_ID ? "dm" : "desktop",
		synthetic: true,
	};
}

function guildName(id: string): string {
	return id === DIRECT_MESSAGE_GUILD_ID ? DIRECT_MESSAGE_GUILD_NAME : `Discord Desktop Guild ${id}`;
}

function kindForChannelType(type: number, dm: boolean): string {
	if (dm) return type === 3 ? "group_dm" : "dm";
	switch (type) {
		case 0:
			return "text";
		case 5:
			return "announcement";
		case 10:
			return "thread_announcement";
		case 11:
			return "thread_public";
		case 12:
			return "thread_private";
		case 15:
			return "forum";
		default:
			return "desktop";
	}
}

function compareMessages(left: CacheMessage, right: CacheMessage): number {
	const leftCursor = parseSnowflake(left.id);
	const rightCursor = parseSnowflake(right.id);
	if (leftCursor !== null && rightCursor !== null) {
		if (leftCursor < rightCursor) return -1;
		if (leftCursor > rightCursor) return 1;
		return 0;
	}
	return left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id);
}

function mostRepeatedDirectMessageAuthor(authorChannels: ReadonlyMap<string, ReadonlySet<string>>): string {
	let selfId = "";
	let selfChannels = 1;
	for (const [authorId, channels] of authorChannels) {
		if (channels.size > selfChannels) {
			selfId = authorId;
			selfChannels = channels.size;
		}
	}
	return selfId;
}

function directMessageChannelName(
	authorCounts: ReadonlyMap<string, number>,
	labels: ReadonlyMap<string, UserLabel>,
	selfId: string,
): string {
	const candidates: string[] = [];
	let bestId = "";
	let bestCount = -1;
	for (const [authorId, count] of authorCounts) {
		const label = labels.get(authorId);
		if (!label?.name) continue;
		if (authorId === selfId && authorCounts.size > 1) continue;
		if (authorCounts.size > 2) {
			candidates.push(label.name);
			continue;
		}
		const bestPriority = labels.get(bestId)?.priority ?? -1;
		if (count > bestCount || (count === bestCount && label.priority > bestPriority)) {
			bestId = authorId;
			bestCount = count;
		}
	}
	if (candidates.length > 0) return candidates.sort().join(", ");
	return labels.get(bestId)?.name ?? "";
}

function shouldUseUserLabel(current: string, label: UserLabel): boolean {
	return !!label.name && current !== label.name && (!current || label.priority >= 2);
}

function isFallbackChannelName(name: string, id: string): boolean {
	return !name || name === `channel-${shortId(id)}` || name === `dm-${shortId(id)}`;
}

function userObjectLabel(raw: Readonly<Record<string, unknown>>): UserLabel | null {
	if (stringField(raw, "global_name")) return { name: stringField(raw, "global_name"), priority: 3 };
	if (stringField(raw, "display_name")) return { name: stringField(raw, "display_name"), priority: 2 };
	if (stringField(raw, "username")) return { name: stringField(raw, "username"), priority: 1 };
	return null;
}

function looksUserObject(raw: Readonly<Record<string, unknown>>): boolean {
	return ["username", "global_name", "display_name", "discriminator", "avatar", "bot", "public_flags"].some(
		(key) => raw[key] !== undefined,
	);
}

function messageReferenceId(raw: Readonly<Record<string, unknown>>): string | undefined {
	const ref = recordField(raw, "message_reference");
	return stringField(ref ?? {}, "message_id") || undefined;
}

function recipientLabel(items: readonly unknown[]): string {
	return items
		.flatMap((item) => {
			if (!isRecord(item)) return [];
			return [
				firstNonEmpty(
					stringField(item, "global_name"),
					stringField(item, "display_name"),
					stringField(item, "username"),
				),
			].filter(Boolean);
		})
		.sort()
		.join(", ");
}

function parseDiscordTime(raw: string): Date | null {
	if (!raw || raw === "null") return null;
	const ms = Date.parse(raw);
	return Number.isFinite(ms) ? new Date(ms) : null;
}

function snowflakeTime(id: string): Date | null {
	const value = parseSnowflake(id);
	if (value === null) return null;
	return new Date(Number((value >> 22n) + 1_420_070_400_000n));
}

function parseSnowflake(value: string): bigint | null {
	try {
		return BigInt(value);
	} catch {
		return null;
	}
}

function looksSnowflake(value: string): boolean {
	return /^[0-9]{12,24}$/.test(value);
}

function shortId(id: string): string {
	return id.length <= 6 ? id : id.slice(-6);
}

function firstNonEmpty(...values: readonly string[]): string {
	return values.find((value) => value.trim().length > 0)?.trim() ?? "";
}

function stringField(raw: Readonly<Record<string, unknown>>, key: string): string {
	const value = raw[key];
	return typeof value === "string" ? sanitizeCacheText(value.trim()) : "";
}

function intField(raw: Readonly<Record<string, unknown>>, key: string): number {
	const value = raw[key];
	return typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0;
}

function recordField(raw: Readonly<Record<string, unknown>>, key: string): Readonly<Record<string, unknown>> | null {
	const value = raw[key];
	return isRecord(value) ? value : null;
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
