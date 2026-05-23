import { logger } from "./logger";

const DISCORD_API_BASE = "https://discord.com/api/v10";
const PER_PAGE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 1000;
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

export interface DiscordFetchConfig {
	readonly token: string;
}

export interface DiscordGuild {
	readonly id: string;
	readonly name: string;
	readonly icon?: string | null;
	readonly description?: string | null;
}

export interface DiscordChannel {
	readonly id: string;
	readonly type: number;
	readonly guild_id?: string;
	readonly name?: string;
	readonly topic?: string | null;
	readonly parent_id?: string | null;
}

export interface DiscordMessage {
	readonly id: string;
	readonly type: number;
	readonly content: string;
	readonly author: DiscordUser;
	readonly timestamp: string;
	readonly timestampEdited?: string | null;
	readonly channel_id: string;
	readonly referenced_message?: DiscordMessage | null;
	readonly message_reference?: {
		readonly message_id?: string;
		readonly channel_id?: string;
		readonly guild_id?: string;
	};
	readonly attachments?: readonly DiscordAttachment[];
	readonly embeds?: readonly DiscordEmbed[];
	readonly mentions?: readonly DiscordUser[];
	readonly pinned?: boolean;
}

export interface DiscordUser {
	readonly id: string;
	readonly username: string;
	readonly discriminator?: string;
	readonly global_name?: string | null;
	readonly bot?: boolean;
}

export interface DiscordAttachment {
	readonly id: string;
	readonly url: string;
	readonly filename: string;
	readonly size: number;
}

export interface DiscordEmbed {
	readonly title?: string;
	readonly description?: string;
	readonly fields?: readonly { readonly name: string; readonly value: string }[];
}

export interface DiscordThreadMember {
	readonly id: string;
	readonly user_id: string;
}

export interface DiscordFetchResult<T> {
	readonly data: readonly T[];
	readonly rateLimitRemaining: number;
	readonly rateLimitReset: number;
	readonly errors: readonly { readonly message: string; readonly retryable: boolean }[];
}

interface DiscordApiResponse {
	readonly status: number;
	readonly headers: Headers;
	readonly body: unknown;
}

interface RateLimitInfo {
	readonly remaining: number;
	readonly reset: number;
}

function parseRateLimit(headers: Headers): RateLimitInfo {
	return {
		remaining: Number(headers.get("x-ratelimit-remaining") ?? "5"),
		reset: Number(headers.get("x-ratelimit-reset") ?? "0") * 1000,
	};
}

async function discordRequest(url: string, token: string, method = "GET", body?: unknown): Promise<DiscordApiResponse> {
	const headers: Record<string, string> = {
		Authorization: `Bot ${token}`,
		"User-Agent": "Signet-Daemon (discord-source)",
	};
	if (body) headers["Content-Type"] = "application/json";

	let lastError: Error | null = null;
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
			const response = await fetch(url, {
				method,
				headers,
				body: body ? JSON.stringify(body) : undefined,
				signal: controller.signal,
			});
			clearTimeout(timeout);

			const rateLimit = parseRateLimit(response.headers);
			if (response.status === 429) {
				const retryAfter = Number(response.headers.get("retry-after") ?? "5") * 1000;
				logger.warn("discord-source", "Rate limited, backing off", { retryAfterMs: retryAfter });
				await new Promise((resolve) => setTimeout(resolve, Math.min(retryAfter, 60_000)));
				continue;
			}
			if (rateLimit.remaining < 2 && rateLimit.reset > Date.now()) {
				const waitMs = rateLimit.reset - Date.now() + 500;
				logger.warn("discord-source", "Approaching rate limit, backing off", {
					remaining: rateLimit.remaining,
					waitMs,
				});
				await new Promise((resolve) => setTimeout(resolve, Math.min(waitMs, 30_000)));
			}
			if (response.status >= 500) {
				lastError = new Error(`Discord API ${response.status}: ${await response.text()}`);
				await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * (attempt + 1)));
				continue;
			}
			return {
				status: response.status,
				headers: response.headers,
				body: response.status === 204 ? null : await response.json(),
			};
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < MAX_RETRIES - 1) {
				await new Promise((resolve) => setTimeout(resolve, RETRY_BASE_DELAY_MS * (attempt + 1)));
			}
		}
	}
	throw lastError ?? new Error("Discord API request failed after retries");
}

export async function fetchGuild(config: DiscordFetchConfig, guildId: string): Promise<DiscordGuild | null> {
	const url = `${DISCORD_API_BASE}/guilds/${guildId}`;
	const response = await discordRequest(url, config.token);
	if (response.status === 403 || response.status === 404) return null;
	if (response.status !== 200) {
		throw new Error(`Failed to fetch guild ${guildId}: ${response.status}`);
	}
	return response.body as DiscordGuild;
}

export async function fetchGuildChannels(
	config: DiscordFetchConfig,
	guildId: string,
): Promise<DiscordFetchResult<DiscordChannel>> {
	const url = `${DISCORD_API_BASE}/guilds/${guildId}/channels`;
	const response = await discordRequest(url, config.token);
	if (response.status !== 200) {
		return {
			data: [],
			rateLimitRemaining: 5,
			rateLimitReset: 0,
			errors: [
				{
					message: `Channels fetch failed for guild ${guildId}: ${response.status}`,
					retryable: response.status >= 500,
				},
			],
		};
	}
	const channels = response.body as DiscordChannel[];
	const rateLimit = parseRateLimit(response.headers);
	return { data: channels, rateLimitRemaining: rateLimit.remaining, rateLimitReset: rateLimit.reset, errors: [] };
}

export async function fetchChannelMessages(
	config: DiscordFetchConfig,
	channelId: string,
	maxMessages = 1000,
	beforeId?: string,
	sinceId?: string,
): Promise<DiscordFetchResult<DiscordMessage>> {
	const messages: DiscordMessage[] = [];
	const errors: { message: string; retryable: boolean }[] = [];
	let rateLimitRemaining = 5;
	let rateLimitReset = 0;
	let fetched = 0;
	let cursor = beforeId;

	while (fetched < maxMessages) {
		const params = new URLSearchParams({
			limit: String(Math.min(PER_PAGE, maxMessages - fetched)),
		});
		if (cursor) params.set("before", cursor);
		const url = `${DISCORD_API_BASE}/channels/${channelId}/messages?${params}`;
		const response = await discordRequest(url, config.token);
		const rl = parseRateLimit(response.headers);
		rateLimitRemaining = rl.remaining;
		rateLimitReset = rl.reset;

		if (response.status !== 200) {
			errors.push({
				message: `Messages fetch failed for channel ${channelId}: ${response.status}`,
				retryable: response.status >= 500,
			});
			break;
		}
		const batch = response.body as DiscordMessage[];
		if (batch.length === 0) break;

		for (const msg of batch) {
			if (sinceId && BigInt(msg.id) <= BigInt(sinceId)) {
				return { data: messages, rateLimitRemaining, rateLimitReset, errors };
			}
			messages.push(msg);
			fetched++;
		}
		if (batch.length < PER_PAGE) break;
		cursor = batch[batch.length - 1].id;
	}
	return { data: messages, rateLimitRemaining, rateLimitReset, errors };
}

export async function fetchActiveThreads(
	config: DiscordFetchConfig,
	guildId: string,
): Promise<DiscordFetchResult<DiscordChannel>> {
	const url = `${DISCORD_API_BASE}/guilds/${guildId}/threads/active`;
	const response = await discordRequest(url, config.token);
	if (response.status !== 200) {
		return {
			data: [],
			rateLimitRemaining: 5,
			rateLimitReset: 0,
			errors: [
				{
					message: `Active threads fetch failed for guild ${guildId}: ${response.status}`,
					retryable: response.status >= 500,
				},
			],
		};
	}
	const data = response.body as { threads?: DiscordChannel[] };
	const rateLimit = parseRateLimit(response.headers);
	return {
		data: data.threads ?? [],
		rateLimitRemaining: rateLimit.remaining,
		rateLimitReset: rateLimit.reset,
		errors: [],
	};
}

export async function fetchPublicArchivedThreads(
	config: DiscordFetchConfig,
	channelId: string,
	maxThreads = 100,
): Promise<DiscordFetchResult<DiscordChannel>> {
	const threads: DiscordChannel[] = [];
	const errors: { message: string; retryable: boolean }[] = [];
	let rateLimitRemaining = 5;
	let rateLimitReset = 0;
	let cursor: string | undefined;

	while (threads.length < maxThreads) {
		const params = new URLSearchParams({ limit: String(Math.min(100, maxThreads - threads.length)) });
		if (cursor) params.set("before", cursor);
		const url = `${DISCORD_API_BASE}/channels/${channelId}/threads/archived/public?${params}`;
		const response = await discordRequest(url, config.token);
		const rl = parseRateLimit(response.headers);
		rateLimitRemaining = rl.remaining;
		rateLimitReset = rl.reset;

		if (response.status !== 200) {
			errors.push({ message: `Archived threads fetch failed: ${response.status}`, retryable: response.status >= 500 });
			break;
		}
		const data = response.body as { threads?: DiscordChannel[] };
		const batch = data.threads ?? [];
		if (batch.length === 0) break;
		threads.push(...batch);
		if (batch.length < 100) break;
		cursor = batch[batch.length - 1].id;
	}
	return { data: threads, rateLimitRemaining, rateLimitReset, errors };
}

export function isTextChannel(channel: DiscordChannel): boolean {
	return channel.type === 0;
}

export function isThread(channel: DiscordChannel): boolean {
	return channel.type === 11 || channel.type === 12;
}

export function displayName(user: DiscordUser): string {
	return user.global_name ?? user.username;
}

export function snowflakeIdForTimestamp(timestamp: string): string | undefined {
	const ms = Date.parse(timestamp);
	if (!Number.isFinite(ms)) return undefined;
	const discordMs = BigInt(ms) - DISCORD_EPOCH_MS;
	if (discordMs < 0n) return "0";
	return (discordMs << 22n).toString();
}

export function conversationToMarkdown(
	messages: readonly DiscordMessage[],
	channelName: string,
	guildName?: string,
): string {
	const parts: string[] = [];
	if (guildName) parts.push(`**Server:** ${guildName}`);
	parts.push(`**Channel:** #${channelName}`);
	parts.push(`**Messages:** ${messages.length}`);
	const first = messages[0];
	const last = messages[messages.length - 1];
	if (first && last) {
		parts.push(`**Date range:** ${first.timestamp.slice(0, 10)} — ${last.timestamp.slice(0, 10)}`);
	}
	parts.push("");
	for (const msg of messages) {
		const speaker = displayName(msg.author);
		const timestamp = msg.timestamp.slice(0, 16).replace("T", " ");
		const prefix = msg.message_reference ? `${speaker} (replying)` : speaker;
		parts.push(`[${timestamp}] ${prefix}: ${msg.content}`);
		if (msg.attachments && msg.attachments.length > 0) {
			const fileNames = msg.attachments.map((a) => a.filename).join(", ");
			parts.push(`  Attachments: ${fileNames}`);
		}
		if (msg.embeds) {
			for (const embed of msg.embeds) {
				const embedParts: string[] = [];
				if (embed.title) embedParts.push(embed.title);
				if (embed.description) embedParts.push(embed.description);
				if (embed.fields) {
					for (const field of embed.fields) {
						embedParts.push(`${field.name}: ${field.value}`);
					}
				}
				if (embedParts.length > 0) {
					parts.push(`  Embed: ${embedParts.join(" | ").slice(0, 500)}`);
				}
			}
		}
	}
	return parts.join("\n");
}
