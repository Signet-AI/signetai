/**
 * Discord Export Parser for the ingestion engine.
 *
 * Parses DiscordChatExporter JSON format, which can be:
 * 1. A single JSON file with a channel's messages
 * 2. A directory of JSON files (one per channel)
 *
 * DiscordChatExporter schema: { guild, channel, dateRange, messages[] }
 * Each message: { id, type, timestamp, content, author, attachments, embeds, reference }
 *
 * Produces a ParsedDocument with sections grouped by conversation thread/time.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, basename, extname } from "path";
import type { ParsedDocument, ParsedSection } from "./types";

// ---------------------------------------------------------------------------
// DiscordChatExporter JSON types
// ---------------------------------------------------------------------------

interface DiscordExport {
	readonly guild?: {
		readonly id: string;
		readonly name: string;
		readonly iconUrl?: string;
	};
	readonly channel?: {
		readonly id: string;
		readonly type: string;
		readonly categoryId?: string;
		readonly category?: string;
		readonly name: string;
		readonly topic?: string;
	};
	readonly dateRange?: {
		readonly after?: string;
		readonly before?: string;
	};
	readonly messages: readonly DiscordMessage[];
	readonly messageCount?: number;
}

interface DiscordAuthor {
	readonly id: string;
	readonly name: string;
	readonly discriminator?: string;
	readonly nickname?: string;
	readonly color?: string;
	readonly isBot?: boolean;
	readonly avatarUrl?: string;
}

interface DiscordAttachment {
	readonly id: string;
	readonly url: string;
	readonly fileName: string;
	readonly fileSizeBytes: number;
}

interface DiscordEmbed {
	readonly title?: string;
	readonly url?: string;
	readonly description?: string;
	readonly fields?: ReadonlyArray<{
		readonly name: string;
		readonly value: string;
		readonly isInline?: boolean;
	}>;
	readonly author?: { readonly name?: string };
	readonly footer?: { readonly text?: string };
}

interface DiscordReaction {
	readonly emoji: {
		readonly id?: string;
		readonly name: string;
		readonly imageUrl?: string;
	};
	readonly count: number;
}

interface DiscordReference {
	readonly messageId?: string;
	readonly channelId?: string;
	readonly guildId?: string;
}

interface DiscordMessage {
	readonly id: string;
	readonly type: string;
	readonly timestamp: string;
	readonly timestampEdited?: string;
	readonly callEndedTimestamp?: string;
	readonly isPinned?: boolean;
	readonly content: string;
	readonly author: DiscordAuthor;
	readonly attachments?: readonly DiscordAttachment[];
	readonly embeds?: readonly DiscordEmbed[];
	readonly reactions?: readonly DiscordReaction[];
	readonly reference?: DiscordReference;
	readonly mentions?: readonly DiscordAuthor[];
}

// ---------------------------------------------------------------------------
// Message types to skip (noise)
// ---------------------------------------------------------------------------

const SKIP_TYPES = new Set([
	"RecipientAdd",
	"RecipientRemove",
	"ChannelNameChange",
	"ChannelIconChange",
	"ChannelPinnedMessage",
	"GuildMemberJoin",
	"UserPremiumGuildSubscription",
	"UserPremiumGuildSubscriptionTier1",
	"UserPremiumGuildSubscriptionTier2",
	"UserPremiumGuildSubscriptionTier3",
	"ChannelFollowAdd",
	"GuildDiscoveryDisqualified",
	"GuildDiscoveryRequalified",
	"GuildDiscoveryGracePeriodInitialWarning",
	"GuildDiscoveryGracePeriodFinalWarning",
	"ThreadCreated",
	"ApplicationCommand",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Discord export (DiscordChatExporter format) into a ParsedDocument.
 *
 * @param path - Path to a JSON file or directory of JSON files
 * @param options - Optional filtering
 */
export function parseDiscordExport(
	path: string,
	options?: {
		/** Only include these channel names */
		readonly channels?: string[];
		/** Only include messages after this date */
		readonly since?: string;
		/** Only include messages before this date */
		readonly until?: string;
		/** Filter to specific speakers */
		readonly speakers?: string[];
	},
): ParsedDocument {
	const stat = statSync(path);
	const exports: DiscordExport[] = [];

	if (stat.isFile() && extname(path).toLowerCase() === ".json") {
		// Single JSON file
		const parsed = loadExportFile(path);
		if (parsed) exports.push(parsed);
	} else if (stat.isDirectory()) {
		// Directory of JSON files
		const files = readdirSync(path)
			.filter((f) => f.endsWith(".json"))
			.sort();

		for (const file of files) {
			const parsed = loadExportFile(join(path, file));
			if (parsed) exports.push(parsed);
		}
	}

	if (exports.length === 0) {
		return {
			format: "discord_export",
			title: "Discord Export (empty)",
			sections: [],
			metadata: { sourceType: "chat_export", platform: "discord" },
			totalChars: 0,
		};
	}

	const allSections: ParsedSection[] = [];
	let totalChars = 0;
	let totalMessages = 0;
	const channelNames: string[] = [];
	let guildName: string | null = null;

	for (const exp of exports) {
		const channelName = exp.channel?.name || "unknown-channel";

		// Filter by channel name
		if (options?.channels && !options.channels.includes(channelName)) continue;

		channelNames.push(channelName);
		if (exp.guild?.name) guildName = exp.guild.name;

		// Filter messages
		const filtered = filterMessages(exp.messages, options);
		if (filtered.length === 0) continue;

		totalMessages += filtered.length;

		// Group into conversations by reply chains and time proximity
		const threads = groupIntoThreads(filtered);

		for (const thread of threads) {
			const section = threadToSection(thread, channelName);
			if (section) {
				allSections.push(section);
				totalChars += section.content.length;
			}
		}
	}

	const guildLabel = guildName ? ` — ${guildName}` : "";
	return {
		format: "discord_export",
		title: `Discord Export${guildLabel} (${channelNames.length} channels, ${totalMessages} messages)`,
		sections: allSections,
		metadata: {
			sourceType: "chat_export",
			platform: "discord",
			guildName,
			channelCount: channelNames.length,
			channelNames,
			messageCount: totalMessages,
		},
		totalChars,
	};
}

// ---------------------------------------------------------------------------
// Load a single export file
// ---------------------------------------------------------------------------

function isDiscordMessageShape(m: unknown): m is DiscordMessage {
	return (
		typeof m === "object" &&
		m !== null &&
		"author" in m &&
		"content" in m &&
		typeof (m as Record<string, unknown>).author === "object"
	);
}

function loadExportFile(filePath: string): DiscordExport | null {
	try {
		const raw = JSON.parse(readFileSync(filePath, "utf-8"));
		// Validate it looks like a DiscordChatExporter export
		if (
			raw &&
			Array.isArray(raw.messages) &&
			(raw.messages.length === 0 || isDiscordMessageShape(raw.messages[0]))
		) {
			return raw as DiscordExport;
		}
		// Some exports have the messages at the top level as an array
		if (Array.isArray(raw) && raw.length > 0 && isDiscordMessageShape(raw[0])) {
			return { messages: raw as readonly DiscordMessage[] } as DiscordExport;
		}
		return null;
	} catch {
		return null;
	}
}

// ---------------------------------------------------------------------------
// Filter messages
// ---------------------------------------------------------------------------

function filterMessages(
	messages: readonly DiscordMessage[],
	options?: {
		readonly since?: string;
		readonly until?: string;
		readonly speakers?: string[];
	},
): DiscordMessage[] {
	return messages.filter((msg) => {
		// Skip system/noise message types
		if (SKIP_TYPES.has(msg.type)) return false;

		// Skip bot messages with no content
		if (msg.author.isBot && !msg.content?.trim()) return false;

		// Skip empty messages (unless they have attachments or embeds)
		if (
			!msg.content?.trim() &&
			(!msg.attachments || msg.attachments.length === 0) &&
			(!msg.embeds || msg.embeds.length === 0)
		) {
			return false;
		}

		// Date range filter
		if (options?.since) {
			const msgDate = msg.timestamp.slice(0, 10);
			if (msgDate < options.since) return false;
		}
		if (options?.until) {
			const msgDate = msg.timestamp.slice(0, 10);
			if (msgDate > options.until) return false;
		}

		// Speaker filter
		if (options?.speakers) {
			const authorName = msg.author.nickname || msg.author.name;
			if (!options.speakers.some((s) =>
				s.toLowerCase() === authorName.toLowerCase() ||
				s.toLowerCase() === msg.author.name.toLowerCase() ||
				s === msg.author.id
			)) {
				return false;
			}
		}

		return true;
	});
}

// ---------------------------------------------------------------------------
// Thread grouping
// ---------------------------------------------------------------------------

interface ConversationThread {
	readonly threadId: string;
	readonly messages: DiscordMessage[];
	readonly startTimestamp: string;
	readonly endTimestamp: string;
}

/** Time gap threshold for splitting unthreaded messages (30 minutes) */
const TIME_GAP_MS = 30 * 60 * 1000;

function groupIntoThreads(messages: DiscordMessage[]): ConversationThread[] {
	// Sort by timestamp
	const sorted = [...messages].sort(
		(a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp),
	);

	// Group by reply chains
	const replyChains = new Map<string, DiscordMessage[]>();
	const standalone: DiscordMessage[] = [];

	// First pass: identify reply chain roots
	const replyTargets = new Set<string>();
	for (const msg of sorted) {
		if (msg.reference?.messageId) {
			replyTargets.add(msg.reference.messageId);
		}
	}

	// Second pass: group messages
	for (const msg of sorted) {
		if (msg.reference?.messageId) {
			// This is a reply — add to the chain of the referenced message
			const rootId = msg.reference.messageId;
			const chain = replyChains.get(rootId) ?? [];
			chain.push(msg);
			replyChains.set(rootId, chain);
		} else if (replyTargets.has(msg.id)) {
			// This message has replies — it's a chain root
			const chain = replyChains.get(msg.id) ?? [];
			chain.unshift(msg);
			replyChains.set(msg.id, chain);
		} else {
			standalone.push(msg);
		}
	}

	const threads: ConversationThread[] = [];

	// Convert reply chains to threads
	for (const [rootId, msgs] of replyChains) {
		msgs.sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
		if (msgs.length === 0) continue;
		threads.push({
			threadId: `reply-${rootId}`,
			messages: msgs,
			startTimestamp: msgs[0].timestamp,
			endTimestamp: msgs[msgs.length - 1].timestamp,
		});
	}

	// Group standalone messages by time proximity
	let currentBatch: DiscordMessage[] = [];

	for (const msg of standalone) {
		if (currentBatch.length > 0) {
			const lastTime = Date.parse(currentBatch[currentBatch.length - 1].timestamp);
			const currentTime = Date.parse(msg.timestamp);

			if (currentTime - lastTime > TIME_GAP_MS) {
				threads.push({
					threadId: `conv-${currentBatch[0].id}`,
					messages: currentBatch,
					startTimestamp: currentBatch[0].timestamp,
					endTimestamp: currentBatch[currentBatch.length - 1].timestamp,
				});
				currentBatch = [];
			}
		}
		currentBatch.push(msg);
	}

	if (currentBatch.length > 0) {
		threads.push({
			threadId: `conv-${currentBatch[0].id}`,
			messages: currentBatch,
			startTimestamp: currentBatch[0].timestamp,
			endTimestamp: currentBatch[currentBatch.length - 1].timestamp,
		});
	}

	// Sort threads chronologically
	return threads.sort(
		(a, b) => Date.parse(a.startTimestamp) - Date.parse(b.startTimestamp),
	);
}

// ---------------------------------------------------------------------------
// Convert thread to section
// ---------------------------------------------------------------------------

function threadToSection(
	thread: ConversationThread,
	channelName: string,
): ParsedSection | null {
	const lines: string[] = [];

	for (const msg of thread.messages) {
		const speaker = msg.author.nickname || msg.author.name;
		const timestamp = msg.timestamp.slice(0, 16).replace("T", " ");
		let text = msg.content;

		// Include reply context
		if (msg.reference?.messageId) {
			lines.push(`[${timestamp}] ${speaker} (replying): ${text}`);
		} else {
			lines.push(`[${timestamp}] ${speaker}: ${text}`);
		}

		// Include attachments
		if (msg.attachments && msg.attachments.length > 0) {
			const fileNames = msg.attachments.map((a) => a.fileName).join(", ");
			lines.push(`  📎 Attachments: ${fileNames}`);
		}

		// Include embed content (summaries, link previews with text)
		if (msg.embeds) {
			for (const embed of msg.embeds) {
				const parts: string[] = [];
				if (embed.title) parts.push(embed.title);
				if (embed.description) parts.push(embed.description);
				if (embed.fields) {
					for (const field of embed.fields) {
						parts.push(`${field.name}: ${field.value}`);
					}
				}
				if (parts.length > 0) {
					lines.push(`  📋 Embed: ${parts.join(" | ").slice(0, 500)}`);
				}
			}
		}
	}

	const content = lines.join("\n");
	if (content.length < 30) return null;

	const startDate = thread.startTimestamp.slice(0, 16).replace("T", " ");
	const heading = `#${channelName} — ${startDate} (${thread.messages.length} messages)`;

	return {
		heading,
		depth: 2,
		content,
		contentType: "text",
	};
}
