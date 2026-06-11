import type { SignetSourceEntry } from "@signet/core";
import {
	DISCORD_CHANNEL_TYPES,
	type DiscordAttachment,
	type DiscordChannel,
	type DiscordEmbed,
	type DiscordGuildMember,
	type DiscordMessage,
	type DiscordPoll,
	type DiscordReaction,
	type DiscordUser,
} from "./discord-source-fetch";
import type { SourceProviderSyncContext } from "./source-providers";

const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const DISCORD_GATEWAY_IDENTIFY_OP = 2;
const DISCORD_GATEWAY_HEARTBEAT_OP = 1;
const DISCORD_GATEWAY_DISPATCH_OP = 0;
const DISCORD_GATEWAY_HELLO_OP = 10;
const DISCORD_GATEWAY_RECONNECT_OP = 7;
const DISCORD_GATEWAY_INVALID_SESSION_OP = 9;
const DISCORD_GATEWAY_INTENTS =
	1 | // GUILDS
	2 | // GUILD_MEMBERS
	512 | // GUILD_MESSAGES
	1024 | // GUILD_MESSAGE_REACTIONS
	32768; // MESSAGE_CONTENT
const GATEWAY_RECONNECT_DELAY_MS = 1_000;
const GATEWAY_SHOULD_CONTINUE_POLL_MS = 250;

interface DiscordGatewaySocket {
	onopen: ((event: unknown) => void) | null;
	onmessage: ((event: { readonly data: unknown }) => void) | null;
	onerror: ((event: unknown) => void) | null;
	onclose: ((event: { readonly code?: number; readonly reason?: string }) => void) | null;
	send(data: string): void;
	close(code?: number, reason?: string): void;
}

type DiscordGatewaySocketFactory = (url: string) => DiscordGatewaySocket;

let discordGatewaySocketFactory: DiscordGatewaySocketFactory = (url) => new WebSocket(url);

export function setDiscordGatewaySocketFactoryForTest(factory: DiscordGatewaySocketFactory | null): void {
	discordGatewaySocketFactory = factory ?? ((url) => new WebSocket(url));
}

export interface DiscordGatewayTailHandlers {
	readonly source: SignetSourceEntry;
	readonly token: string;
	readonly guildIds: readonly string[];
	readonly shouldContinue: () => boolean;
	readonly onProgress?: SourceProviderSyncContext["onProgress"];
	readonly recordFailure: (message: string, metadata: Readonly<Record<string, unknown>>, recoverable: boolean) => void;
	readonly recordMessage: (
		guildId: string,
		channelId: string,
		messageId: string,
		message: DiscordMessage | null,
		gatewayEventType: string,
		sequence: number | null,
		payload: unknown,
	) => void;
	readonly recordMessageDelete: (
		guildId: string,
		channelId: string,
		messageId: string,
		sequence: number | null,
		payload: unknown,
	) => void;
	readonly recordChannel: (guildId: string, channel: DiscordChannel) => void;
	readonly recordMember: (guildId: string, member: DiscordGuildMember) => void;
	readonly recordMemberRemove: (guildId: string, userId: string, sequence: number | null, payload: unknown) => void;
}

export async function syncDiscordGatewayTail(
	input: DiscordGatewayTailHandlers,
): Promise<{ readonly indexedEvents: number; readonly failures: number; readonly canceled: boolean }> {
	let indexedEvents = 0;
	let failures = 0;
	const allowedGuilds = new Set(input.guildIds);
	while (input.shouldContinue()) {
		const result = await runDiscordGatewayConnection({
			...input,
			allowedGuilds,
			recordFailure: (message, metadata, recoverable) => {
				failures++;
				input.recordFailure(message, metadata, recoverable);
			},
			recordEvent: () => {
				indexedEvents++;
			},
		});
		if (!result.retry) break;
		await Bun.sleep(GATEWAY_RECONNECT_DELAY_MS);
	}
	return { indexedEvents, failures, canceled: !input.shouldContinue() };
}

async function runDiscordGatewayConnection(
	input: DiscordGatewayTailHandlers & {
		readonly allowedGuilds: ReadonlySet<string>;
		readonly recordEvent: () => void;
	},
): Promise<{ readonly retry: boolean }> {
	return await new Promise((resolve) => {
		const socket = discordGatewaySocketFactory(DISCORD_GATEWAY_URL);
		let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
		let continueTimer: ReturnType<typeof setInterval> | null = null;
		let sequence: number | null = null;
		let settled = false;
		let closeFailureRecorded = false;
		let reconnectRequested = false;
		const cleanup = (): void => {
			if (heartbeatTimer) clearInterval(heartbeatTimer);
			if (continueTimer) clearInterval(continueTimer);
			heartbeatTimer = null;
			continueTimer = null;
		};
		const settle = (retry: boolean): void => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({ retry });
		};
		const closeForCancellation = (): void => {
			try {
				socket.close(1000, "source sync canceled");
			} catch {
				settle(false);
			}
		};
		continueTimer = setInterval(() => {
			if (!input.shouldContinue()) closeForCancellation();
		}, GATEWAY_SHOULD_CONTINUE_POLL_MS);
		socket.onopen = () => {
			input.onProgress?.({ scanned: 0, total: input.allowedGuilds.size, indexed: 0, currentPath: "discord://gateway" });
		};
		socket.onerror = () => {
			closeFailureRecorded = true;
			input.recordFailure("Discord gateway websocket error", { phase: "gateway_tail" }, true);
			try {
				socket.close(1011, "gateway websocket error");
			} catch {
				settle(true);
			}
		};
		socket.onclose = (event) => {
			if (!input.shouldContinue()) {
				settle(false);
				return;
			}
			if (reconnectRequested) {
				settle(true);
				return;
			}
			if (isFatalGatewayCloseCode(event.code)) {
				input.recordFailure(
					`Discord gateway closed with non-retryable code ${event.code}${event.reason ? `: ${event.reason}` : ""}`,
					{ phase: "gateway_tail", code: event.code ?? null },
					false,
				);
				settle(false);
				return;
			}
			if (!closeFailureRecorded)
				input.recordFailure(
					`Discord gateway closed unexpectedly${event.reason ? `: ${event.reason}` : ""}`,
					{ phase: "gateway_tail", code: event.code ?? null },
					true,
				);
			settle(true);
		};
		socket.onmessage = (event) => {
			const payload = parseGatewayPayload(event.data);
			if (!payload) return;
			if (typeof payload.s === "number") sequence = payload.s;
			if (payload.op === DISCORD_GATEWAY_HELLO_OP) {
				const heartbeatInterval = gatewayHeartbeatInterval(payload.d);
				if (heartbeatInterval !== null) {
					heartbeatTimer = setInterval(() => {
						socket.send(JSON.stringify({ op: DISCORD_GATEWAY_HEARTBEAT_OP, d: sequence }));
					}, heartbeatInterval);
				}
				socket.send(
					JSON.stringify({
						op: DISCORD_GATEWAY_IDENTIFY_OP,
						d: {
							token: input.token,
							intents: DISCORD_GATEWAY_INTENTS,
							properties: { os: "linux", browser: "signet", device: "signet" },
						},
					}),
				);
				return;
			}
			if (payload.op === DISCORD_GATEWAY_RECONNECT_OP || payload.op === DISCORD_GATEWAY_INVALID_SESSION_OP) {
				reconnectRequested = true;
				try {
					socket.close(1012, "discord requested reconnect");
				} catch {
					settle(true);
				}
				return;
			}
			if (payload.op !== DISCORD_GATEWAY_DISPATCH_OP || typeof payload.t !== "string") return;
			const eventResult = handleDiscordGatewayDispatch({
				...input,
				eventType: payload.t,
				sequence,
				data: payload.d,
			});
			if (!eventResult.indexed) return;
			input.recordEvent();
			input.onProgress?.({
				scanned: 0,
				total: input.allowedGuilds.size,
				indexed: 0,
				currentPath: eventResult.path,
			});
		};
	});
}

function handleDiscordGatewayDispatch(
	input: DiscordGatewayTailHandlers & {
		readonly allowedGuilds: ReadonlySet<string>;
		readonly eventType: string;
		readonly sequence: number | null;
		readonly data: unknown;
	},
): { readonly indexed: boolean; readonly path: string } {
	if (!isRecord(input.data)) return { indexed: false, path: "discord://gateway" };
	const guildId = readString(input.data, "guild_id");
	if (!guildId || !input.allowedGuilds.has(guildId)) return { indexed: false, path: "discord://gateway" };
	if (input.eventType === "MESSAGE_CREATE" || input.eventType === "MESSAGE_UPDATE") {
		const channelId = readString(input.data, "channel_id");
		const messageId = readString(input.data, "id");
		if (!channelId || !messageId) return { indexed: false, path: "discord://gateway" };
		input.recordMessage(
			guildId,
			channelId,
			messageId,
			gatewayMessage(input.data),
			input.eventType,
			input.sequence,
			input.data,
		);
		return { indexed: true, path: `discord://guild/${guildId}/channel/${channelId}/messages/${messageId}` };
	}
	if (input.eventType === "MESSAGE_DELETE") {
		const channelId = readString(input.data, "channel_id");
		const messageId = readString(input.data, "id");
		if (!channelId || !messageId) return { indexed: false, path: "discord://gateway" };
		input.recordMessageDelete(guildId, channelId, messageId, input.sequence, input.data);
		return { indexed: true, path: `discord://guild/${guildId}/channel/${channelId}/messages/${messageId}` };
	}
	if (
		input.eventType === "CHANNEL_CREATE" ||
		input.eventType === "CHANNEL_UPDATE" ||
		input.eventType === "THREAD_CREATE" ||
		input.eventType === "THREAD_UPDATE"
	) {
		const channel = gatewayChannelFromEvent(input.data);
		if (!channel) return { indexed: false, path: "discord://gateway" };
		input.recordChannel(guildId, channel);
		return { indexed: true, path: `discord://guild/${guildId}/channel/${channel.id}` };
	}
	if (input.eventType === "GUILD_MEMBER_ADD" || input.eventType === "GUILD_MEMBER_UPDATE") {
		const member = gatewayMember(input.data);
		if (!member) return { indexed: false, path: "discord://gateway" };
		input.recordMember(guildId, member);
		return { indexed: true, path: `discord://guild/${guildId}/member/${member.user?.id ?? "unknown"}` };
	}
	if (input.eventType === "GUILD_MEMBER_REMOVE") {
		const user = gatewayUser(input.data.user);
		if (!user) return { indexed: false, path: "discord://gateway" };
		input.recordMemberRemove(guildId, user.id, input.sequence, input.data);
		return { indexed: true, path: `discord://guild/${guildId}/member/${user.id}` };
	}
	return { indexed: false, path: "discord://gateway" };
}

interface DiscordGatewayPayload {
	readonly op: number;
	readonly t?: string | null;
	readonly s?: number | null;
	readonly d?: unknown;
}

function parseGatewayPayload(data: unknown): DiscordGatewayPayload | null {
	const text =
		typeof data === "string"
			? data
			: data instanceof ArrayBuffer
				? new TextDecoder().decode(data)
				: data instanceof Uint8Array
					? new TextDecoder().decode(data)
					: null;
	if (text === null) return null;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!isRecord(parsed) || typeof parsed.op !== "number") return null;
		return {
			op: parsed.op,
			t: typeof parsed.t === "string" ? parsed.t : null,
			s: typeof parsed.s === "number" ? parsed.s : null,
			d: parsed.d,
		};
	} catch {
		return null;
	}
}

function gatewayHeartbeatInterval(data: unknown): number | null {
	if (!isRecord(data) || typeof data.heartbeat_interval !== "number") return null;
	return Math.max(1_000, data.heartbeat_interval);
}

function isFatalGatewayCloseCode(code: number | undefined): boolean {
	return code === 4004 || code === 4010 || code === 4011 || code === 4013 || code === 4014;
}

function gatewayChannelFromEvent(data: Record<string, unknown>): DiscordChannel | null {
	const id = readString(data, "id");
	const guildId = readString(data, "guild_id");
	const type = typeof data.type === "number" ? data.type : DISCORD_CHANNEL_TYPES.guildText;
	if (!id || !guildId) return null;
	const name = readString(data, "name") ?? undefined;
	const topic = readString(data, "topic");
	const parentId = readString(data, "parent_id");
	return {
		id,
		guild_id: guildId,
		type,
		...(name ? { name } : {}),
		...(topic ? { topic } : {}),
		...(parentId ? { parent_id: parentId } : {}),
		...(isRecord(data.thread_metadata) ? { thread_metadata: data.thread_metadata } : {}),
	};
}

function gatewayMessage(data: Record<string, unknown>): DiscordMessage | null {
	const id = readString(data, "id");
	const channelId = readString(data, "channel_id");
	const content = readString(data, "content");
	const timestamp = readString(data, "timestamp");
	const author = gatewayUser(data.author);
	if (!id || !channelId || content === null || !timestamp || !author) return null;
	return {
		id,
		channel_id: channelId,
		content,
		timestamp,
		type: typeof data.type === "number" ? data.type : 0,
		author,
		...(readString(data, "edited_timestamp") ? { edited_timestamp: readString(data, "edited_timestamp") } : {}),
		...(typeof data.flags === "number" ? { flags: data.flags } : {}),
		...(readString(data, "webhook_id") ? { webhook_id: readString(data, "webhook_id") ?? undefined } : {}),
		...(isRecord(data.message_reference) ? { message_reference: gatewayMessageReference(data.message_reference) } : {}),
		...(isRecord(data.referenced_message) ? { referenced_message: gatewayMessage(data.referenced_message) } : {}),
		...(Array.isArray(data.attachments)
			? { attachments: data.attachments.map(gatewayAttachment).filter(isPresent) }
			: {}),
		...(Array.isArray(data.embeds) ? { embeds: data.embeds.map(gatewayEmbed).filter(isPresent) } : {}),
		...(Array.isArray(data.mentions) ? { mentions: data.mentions.map(gatewayUser).filter(isPresent) } : {}),
		...(Array.isArray(data.mention_roles) ? { mention_roles: data.mention_roles.filter(isString) } : {}),
		...(typeof data.pinned === "boolean" ? { pinned: data.pinned } : {}),
		...(isRecord(data.poll) ? { poll: gatewayPoll(data.poll) } : {}),
		...(Array.isArray(data.reactions) ? { reactions: data.reactions.map(gatewayReaction).filter(isPresent) } : {}),
	};
}

function gatewayUser(data: unknown): DiscordUser | null {
	if (!isRecord(data)) return null;
	const id = readString(data, "id");
	const username = readString(data, "username") ?? readString(data, "global_name") ?? id;
	if (!id || !username) return null;
	return {
		id,
		username,
		...(readString(data, "discriminator") ? { discriminator: readString(data, "discriminator") ?? undefined } : {}),
		...(readString(data, "global_name") ? { global_name: readString(data, "global_name") } : {}),
		...(typeof data.bot === "boolean" ? { bot: data.bot } : {}),
	};
}

function gatewayMember(data: Record<string, unknown>): DiscordGuildMember | null {
	const user = gatewayUser(data.user);
	if (!user) return null;
	return {
		user,
		...(readString(data, "nick") ? { nick: readString(data, "nick") } : {}),
		...(Array.isArray(data.roles) ? { roles: data.roles.filter(isString) } : {}),
		...(readString(data, "joined_at") ? { joined_at: readString(data, "joined_at") } : {}),
	};
}

function gatewayAttachment(data: unknown): DiscordAttachment | null {
	if (!isRecord(data)) return null;
	const id = readString(data, "id");
	const filename = readString(data, "filename");
	const size = typeof data.size === "number" ? data.size : 0;
	if (!id || !filename) return null;
	return {
		id,
		filename,
		size,
		...(readString(data, "url") ? { url: readString(data, "url") ?? undefined } : {}),
		...(readString(data, "proxy_url") ? { proxy_url: readString(data, "proxy_url") ?? undefined } : {}),
		...(readString(data, "content_type") ? { content_type: readString(data, "content_type") ?? undefined } : {}),
		...(readString(data, "description") ? { description: readString(data, "description") } : {}),
		...(typeof data.width === "number" ? { width: data.width } : {}),
		...(typeof data.height === "number" ? { height: data.height } : {}),
	};
}

function gatewayEmbed(data: unknown): DiscordEmbed | null {
	if (!isRecord(data)) return null;
	const fields = Array.isArray(data.fields)
		? data.fields.flatMap((field) => {
				if (!isRecord(field)) return [];
				const name = readString(field, "name");
				const value = readString(field, "value");
				return name && value ? [{ name, value }] : [];
			})
		: undefined;
	return {
		...(readString(data, "title") ? { title: readString(data, "title") ?? undefined } : {}),
		...(readString(data, "description") ? { description: readString(data, "description") ?? undefined } : {}),
		...(readString(data, "url") ? { url: readString(data, "url") ?? undefined } : {}),
		...(readString(data, "type") ? { type: readString(data, "type") ?? undefined } : {}),
		...(fields && fields.length > 0 ? { fields } : {}),
	};
}

function gatewayPoll(data: Record<string, unknown>): DiscordPoll {
	const question = isRecord(data.question) ? readString(data.question, "text") : null;
	const answers = Array.isArray(data.answers)
		? data.answers.flatMap((answer) => {
				if (!isRecord(answer)) return [];
				const pollMedia = isRecord(answer.poll_media) ? readString(answer.poll_media, "text") : null;
				const answerId = typeof answer.answer_id === "number" ? answer.answer_id : undefined;
				return [
					{ ...(answerId ? { answer_id: answerId } : {}), ...(pollMedia ? { poll_media: { text: pollMedia } } : {}) },
				];
			})
		: undefined;
	return {
		...(question ? { question: { text: question } } : {}),
		...(answers && answers.length > 0 ? { answers } : {}),
	};
}

function gatewayReaction(data: unknown): DiscordReaction | null {
	if (!isRecord(data)) return null;
	const emoji = isRecord(data.emoji)
		? { emoji: { id: readString(data.emoji, "id"), name: readString(data.emoji, "name") } }
		: {};
	return { ...(typeof data.count === "number" ? { count: data.count } : {}), ...emoji };
}

function gatewayMessageReference(data: Record<string, unknown>): DiscordMessage["message_reference"] {
	return {
		...(readString(data, "message_id") ? { message_id: readString(data, "message_id") ?? undefined } : {}),
		...(readString(data, "channel_id") ? { channel_id: readString(data, "channel_id") ?? undefined } : {}),
		...(readString(data, "guild_id") ? { guild_id: readString(data, "guild_id") ?? undefined } : {}),
	};
}

function readString(record: Record<string, unknown>, key: string): string | null {
	const value = record[key];
	return typeof value === "string" && value.trim().length > 0 ? value : null;
}

function isString(value: unknown): value is string {
	return typeof value === "string";
}

function isPresent<T>(value: T | null): value is T {
	return value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
