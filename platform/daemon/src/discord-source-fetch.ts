const DISCORD_API_BASE = "https://discord.com/api/v10";
const PER_PAGE = 100;
const REQUEST_TIMEOUT_MS = 30_000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY_MS = 250;
const DISCORD_EPOCH_MS = 1_420_070_400_000n;

export const DISCORD_CHANNEL_TYPES = {
	guildText: 0,
	guildCategory: 4,
	guildAnnouncement: 5,
	announcementThread: 10,
	publicThread: 11,
	privateThread: 12,
	guildForum: 15,
	guildMedia: 16,
} as const;

export interface DiscordFetchConfig {
	readonly token: string;
	readonly fetchImpl?: typeof fetch;
	readonly sleepMs?: (ms: number) => Promise<void>;
}

export interface DiscordGuild {
	readonly id: string;
	readonly name: string;
	readonly icon?: string | null;
	readonly description?: string | null;
	readonly approximate_member_count?: number;
	readonly approximate_presence_count?: number;
}

export interface DiscordChannel {
	readonly id: string;
	readonly type: number;
	readonly guild_id?: string;
	readonly name?: string;
	readonly topic?: string | null;
	readonly parent_id?: string | null;
	readonly thread_metadata?: {
		readonly archived?: boolean;
		readonly archive_timestamp?: string;
		readonly locked?: boolean;
	};
}

export interface DiscordMessage {
	readonly id: string;
	readonly type: number;
	readonly content: string;
	readonly author: DiscordUser;
	readonly timestamp: string;
	readonly edited_timestamp?: string | null;
	readonly channel_id: string;
	readonly flags?: number;
	readonly webhook_id?: string;
	readonly referenced_message?: DiscordMessage | null;
	readonly message_reference?: {
		readonly message_id?: string;
		readonly channel_id?: string;
		readonly guild_id?: string;
	};
	readonly attachments?: readonly DiscordAttachment[];
	readonly embeds?: readonly DiscordEmbed[];
	readonly mentions?: readonly DiscordUser[];
	readonly mention_roles?: readonly string[];
	readonly pinned?: boolean;
	readonly poll?: DiscordPoll;
	readonly reactions?: readonly DiscordReaction[];
}

export interface DiscordUser {
	readonly id: string;
	readonly username: string;
	readonly discriminator?: string;
	readonly global_name?: string | null;
	readonly bot?: boolean;
}

export interface DiscordGuildMember {
	readonly user?: DiscordUser;
	readonly nick?: string | null;
	readonly roles?: readonly string[];
	readonly joined_at?: string | null;
}

export interface DiscordAttachment {
	readonly id: string;
	readonly url?: string;
	readonly proxy_url?: string;
	readonly filename: string;
	readonly size: number;
	readonly content_type?: string;
	readonly description?: string | null;
	readonly width?: number | null;
	readonly height?: number | null;
}

export interface DiscordEmbed {
	readonly title?: string;
	readonly description?: string;
	readonly url?: string;
	readonly type?: string;
	readonly fields?: readonly { readonly name: string; readonly value: string }[];
}

export interface DiscordPoll {
	readonly question?: { readonly text?: string };
	readonly answers?: readonly { readonly answer_id?: number; readonly poll_media?: { readonly text?: string } }[];
}

export interface DiscordReaction {
	readonly count?: number;
	readonly emoji?: {
		readonly id?: string | null;
		readonly name?: string | null;
	};
}

export interface DiscordThreadMember {
	readonly id?: string;
	readonly user_id?: string;
	readonly member?: DiscordGuildMember;
}

export interface DiscordFetchResult<T> {
	readonly data: readonly T[];
	readonly rateLimitRemaining: number;
	readonly rateLimitReset: number;
	readonly errors: readonly DiscordFetchError[];
	readonly exhausted?: boolean;
	readonly reachedLowerBound?: boolean;
}

export interface DiscordFetchError {
	readonly message: string;
	readonly retryable: boolean;
	readonly status?: number;
}

interface DiscordApiResponse {
	readonly status: number;
	readonly headers: Headers;
	readonly body: unknown;
}

function parseRateLimit(headers: Headers): { remaining: number; reset: number } {
	return {
		remaining: Number(headers.get("x-ratelimit-remaining") ?? "5"),
		reset: Number(headers.get("x-ratelimit-reset") ?? "0") * 1000,
	};
}

function parseSnowflake(value: string): bigint | null {
	try {
		return BigInt(value);
	} catch {
		return null;
	}
}

async function parseDiscordResponseBody(response: Response): Promise<unknown> {
	if (response.status === 204) return null;
	const raw = await response.text();
	if (raw.trim().length === 0) return null;
	try {
		return JSON.parse(raw) as unknown;
	} catch {
		return raw;
	}
}

async function discordRequest(config: DiscordFetchConfig, path: string): Promise<DiscordApiResponse> {
	const fetchImpl = config.fetchImpl ?? fetch;
	const sleepMs = config.sleepMs ?? Bun.sleep;
	let lastError: Error | null = null;
	for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
		try {
			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
			try {
				const response = await fetchImpl(`${DISCORD_API_BASE}${path}`, {
					headers: {
						Authorization: `Bot ${config.token}`,
						"User-Agent": "Signet-Daemon (discord-source)",
					},
					signal: controller.signal,
				});

				if (response.status === 429) {
					const retryAfter = Number(response.headers.get("retry-after") ?? "1") * 1000;
					await sleepMs(Math.min(retryAfter, 60_000));
					continue;
				}
				if (response.status >= 500 && attempt < MAX_RETRIES - 1) {
					lastError = new Error(`Discord API ${response.status}: ${await response.clone().text()}`);
					await sleepMs(RETRY_BASE_DELAY_MS * (attempt + 1));
					continue;
				}
				return {
					status: response.status,
					headers: response.headers,
					body: await parseDiscordResponseBody(response),
				};
			} finally {
				clearTimeout(timeout);
			}
		} catch (err) {
			lastError = err instanceof Error ? err : new Error(String(err));
			if (attempt < MAX_RETRIES - 1) await sleepMs(RETRY_BASE_DELAY_MS * (attempt + 1));
		}
	}
	throw lastError ?? new Error("Discord API request failed after retries");
}

export async function fetchGuild(config: DiscordFetchConfig, guildId: string): Promise<DiscordGuild | null> {
	const response = await discordRequest(config, `/guilds/${guildId}?with_counts=true`);
	if (response.status === 403 || response.status === 404) return null;
	if (response.status !== 200) throw new Error(`Failed to fetch Discord guild ${guildId}: ${response.status}`);
	return response.body as DiscordGuild;
}

export async function fetchGuildChannels(
	config: DiscordFetchConfig,
	guildId: string,
): Promise<DiscordFetchResult<DiscordChannel>> {
	const prefix = `Channels fetch failed for guild ${guildId}`;
	const response = await catchDiscordRequest(config, `/guilds/${guildId}/channels`);
	if (!response.ok) return failedExceptionResult(prefix, response.error);
	if (response.status !== 200) return failedResult(`Channels fetch failed for guild ${guildId}`, response);
	const rl = parseRateLimit(response.headers);
	return {
		data: Array.isArray(response.body) ? (response.body as DiscordChannel[]) : [],
		rateLimitRemaining: rl.remaining,
		rateLimitReset: rl.reset,
		errors: [],
	};
}

export async function fetchGuildMembers(
	config: DiscordFetchConfig,
	guildId: string,
	maxMembers = 1000,
): Promise<DiscordFetchResult<DiscordGuildMember>> {
	const members: DiscordGuildMember[] = [];
	const errors: DiscordFetchError[] = [];
	let after: string | undefined;
	let rateLimitRemaining = 5;
	let rateLimitReset = 0;
	while (members.length < maxMembers) {
		const params = new URLSearchParams({ limit: String(Math.min(PER_PAGE, maxMembers - members.length)) });
		if (after) params.set("after", after);
		const prefix = `Members fetch failed for guild ${guildId}`;
		const response = await catchDiscordRequest(config, `/guilds/${guildId}/members?${params}`);
		if (!response.ok) {
			errors.push(errorForException(prefix, response.error));
			break;
		}
		const rl = parseRateLimit(response.headers);
		rateLimitRemaining = rl.remaining;
		rateLimitReset = rl.reset;
		if (response.status !== 200) {
			errors.push(errorForResponse(`Members fetch failed for guild ${guildId}`, response));
			break;
		}
		const batch = Array.isArray(response.body) ? (response.body as DiscordGuildMember[]) : [];
		if (batch.length === 0) break;
		members.push(...batch);
		const lastUserId = batch[batch.length - 1]?.user?.id;
		if (!lastUserId || batch.length < PER_PAGE) break;
		after = lastUserId;
	}
	return { data: members, rateLimitRemaining, rateLimitReset, errors };
}

export async function fetchChannelMessages(
	config: DiscordFetchConfig,
	channelId: string,
	maxMessages = 1000,
	beforeId?: string,
	sinceId?: string,
	afterId?: string,
): Promise<DiscordFetchResult<DiscordMessage>> {
	const messages: DiscordMessage[] = [];
	const errors: DiscordFetchError[] = [];
	let cursor = beforeId;
	let afterCursor = afterId;
	let fetched = 0;
	let rateLimitRemaining = 5;
	let rateLimitReset = 0;
	let exhausted = false;
	let reachedLowerBound = false;
	if (beforeId && afterId) {
		return {
			data: [],
			rateLimitRemaining,
			rateLimitReset,
			errors: [
				{
					message: `Messages fetch cannot use both before and after cursors for channel ${channelId}`,
					retryable: false,
				},
			],
		};
	}
	const malformedLowerBound = [sinceId, afterId].find((value) => value && parseSnowflake(value) === null);
	if (malformedLowerBound) {
		return {
			data: [],
			rateLimitRemaining,
			rateLimitReset,
			errors: [
				{
					message: `Messages fetch used malformed lower-bound id for channel ${channelId}: ${malformedLowerBound}`,
					retryable: false,
				},
			],
		};
	}
	const effectiveSinceId = newestSnowflakeBound(sinceId, afterId);
	const sinceSnowflake = effectiveSinceId ? parseSnowflake(effectiveSinceId) : null;
	while (fetched < maxMessages) {
		const pageLimit = Math.min(PER_PAGE, maxMessages - fetched);
		const params = new URLSearchParams({ limit: String(pageLimit) });
		if (cursor) params.set("before", cursor);
		if (afterCursor) params.set("after", afterCursor);
		const prefix = `Messages fetch failed for channel ${channelId}`;
		const response = await catchDiscordRequest(config, `/channels/${channelId}/messages?${params}`);
		if (!response.ok) {
			errors.push(errorForException(prefix, response.error));
			break;
		}
		const rl = parseRateLimit(response.headers);
		rateLimitRemaining = rl.remaining;
		rateLimitReset = rl.reset;
		if (response.status !== 200) {
			errors.push(errorForResponse(`Messages fetch failed for channel ${channelId}`, response));
			break;
		}
		const batch = Array.isArray(response.body) ? (response.body as DiscordMessage[]) : [];
		if (batch.length === 0) {
			exhausted = true;
			break;
		}
		for (const msg of batch) {
			if (sinceSnowflake !== null) {
				const msgSnowflake = parseSnowflake(msg.id);
				if (msgSnowflake === null) {
					errors.push({
						message: `Messages fetch returned malformed message id for channel ${channelId}: ${msg.id}`,
						retryable: false,
					});
					continue;
				}
				if (msgSnowflake <= sinceSnowflake) {
					reachedLowerBound = true;
					return { data: messages, rateLimitRemaining, rateLimitReset, errors, exhausted, reachedLowerBound };
				}
			}
			messages.push(msg);
			fetched++;
		}
		if (batch.length < pageLimit) {
			exhausted = true;
			break;
		}
		cursor = batch[batch.length - 1]?.id;
		afterCursor = undefined;
	}
	return { data: messages, rateLimitRemaining, rateLimitReset, errors, exhausted, reachedLowerBound };
}

function newestSnowflakeBound(left?: string, right?: string): string | undefined {
	if (!left) return right;
	if (!right) return left;
	const leftId = parseSnowflake(left);
	const rightId = parseSnowflake(right);
	if (leftId === null || rightId === null) return left;
	return leftId > rightId ? left : right;
}

export async function fetchGuildActiveThreads(
	config: DiscordFetchConfig,
	guildId: string,
): Promise<DiscordFetchResult<DiscordChannel>> {
	const prefix = `Active threads fetch failed for guild ${guildId}`;
	const response = await catchDiscordRequest(config, `/guilds/${guildId}/threads/active`);
	if (!response.ok) return failedExceptionResult(prefix, response.error);
	if (response.status !== 200) return failedResult(`Active threads fetch failed for guild ${guildId}`, response);
	const rl = parseRateLimit(response.headers);
	const body = isRecord(response.body) ? response.body : {};
	return {
		data: Array.isArray(body.threads) ? (body.threads as DiscordChannel[]) : [],
		rateLimitRemaining: rl.remaining,
		rateLimitReset: rl.reset,
		errors: [],
	};
}

export async function fetchArchivedThreads(
	config: DiscordFetchConfig,
	channelId: string,
	kind: "public" | "private",
	maxThreads = 1000,
): Promise<DiscordFetchResult<DiscordChannel>> {
	const threads: DiscordChannel[] = [];
	const errors: DiscordFetchError[] = [];
	let before: string | undefined;
	let rateLimitRemaining = 5;
	let rateLimitReset = 0;
	while (threads.length < maxThreads) {
		const params = new URLSearchParams({ limit: String(Math.min(PER_PAGE, maxThreads - threads.length)) });
		if (before) params.set("before", before);
		const prefix = `Archived ${kind} threads fetch failed for channel ${channelId}`;
		const response = await catchDiscordRequest(config, `/channels/${channelId}/threads/archived/${kind}?${params}`);
		if (!response.ok) {
			errors.push(errorForException(prefix, response.error));
			break;
		}
		const rl = parseRateLimit(response.headers);
		rateLimitRemaining = rl.remaining;
		rateLimitReset = rl.reset;
		if (response.status !== 200) {
			errors.push(errorForResponse(`Archived ${kind} threads fetch failed for channel ${channelId}`, response));
			break;
		}
		const body = isRecord(response.body) ? response.body : {};
		const batch = Array.isArray(body.threads) ? (body.threads as DiscordChannel[]) : [];
		if (batch.length === 0) break;
		threads.push(...batch);
		if (batch.length < PER_PAGE || body.has_more === false) break;
		before = batch[batch.length - 1]?.thread_metadata?.archive_timestamp;
		if (!before) break;
	}
	return { data: threads, rateLimitRemaining, rateLimitReset, errors };
}

export async function fetchThreadMembers(
	config: DiscordFetchConfig,
	threadId: string,
): Promise<DiscordFetchResult<DiscordThreadMember>> {
	const prefix = `Thread members fetch failed for thread ${threadId}`;
	const response = await catchDiscordRequest(config, `/channels/${threadId}/thread-members?with_member=true`);
	if (!response.ok) return failedExceptionResult(prefix, response.error);
	if (response.status !== 200) return failedResult(`Thread members fetch failed for thread ${threadId}`, response);
	const rl = parseRateLimit(response.headers);
	return {
		data: Array.isArray(response.body) ? (response.body as DiscordThreadMember[]) : [],
		rateLimitRemaining: rl.remaining,
		rateLimitReset: rl.reset,
		errors: [],
	};
}

export function isDiscordTextReadableChannel(channel: DiscordChannel): boolean {
	return (
		channel.type === DISCORD_CHANNEL_TYPES.guildText ||
		channel.type === DISCORD_CHANNEL_TYPES.guildAnnouncement ||
		isDiscordThread(channel)
	);
}

export function isDiscordThread(channel: DiscordChannel): boolean {
	return (
		channel.type === DISCORD_CHANNEL_TYPES.announcementThread ||
		channel.type === DISCORD_CHANNEL_TYPES.publicThread ||
		channel.type === DISCORD_CHANNEL_TYPES.privateThread
	);
}

export function snowflakeIdForTimestamp(timestamp: string): string | undefined {
	const ms = Date.parse(timestamp);
	if (!Number.isFinite(ms)) return undefined;
	const discordMs = BigInt(ms) - DISCORD_EPOCH_MS;
	if (discordMs < 0n) return "0";
	return (discordMs << 22n).toString();
}

export function discordDisplayName(user: DiscordUser): string {
	return user.global_name ?? user.username;
}

function failedResult<T>(prefix: string, response: DiscordApiResponse): DiscordFetchResult<T> {
	return {
		data: [],
		rateLimitRemaining: 5,
		rateLimitReset: 0,
		errors: [errorForResponse(prefix, response)],
	};
}

async function catchDiscordRequest(
	config: DiscordFetchConfig,
	path: string,
): Promise<({ readonly ok: true } & DiscordApiResponse) | { readonly ok: false; readonly error: unknown }> {
	try {
		return { ok: true, ...(await discordRequest(config, path)) };
	} catch (err) {
		return { ok: false, error: err };
	}
}

function failedExceptionResult<T>(prefix: string, err: unknown): DiscordFetchResult<T> {
	return {
		data: [],
		rateLimitRemaining: 5,
		rateLimitReset: 0,
		errors: [errorForException(prefix, err)],
	};
}

function errorForResponse(prefix: string, response: DiscordApiResponse): DiscordFetchError {
	const suffix =
		typeof response.body === "string"
			? `: ${response.body.slice(0, 200)}`
			: isRecord(response.body) && typeof response.body.message === "string"
				? `: ${response.body.message}`
				: "";
	return {
		message: `${prefix}: ${response.status}${suffix}`,
		retryable: response.status >= 500,
		status: response.status,
	};
}

function errorForException(prefix: string, err: unknown): DiscordFetchError {
	return {
		message: `${prefix}: ${err instanceof Error ? err.message : String(err)}`,
		retryable: true,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
