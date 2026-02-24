/**
 * Slack Export Parser for the ingestion engine.
 *
 * Parses the Slack JSON export format:
 * - Root directory contains channels.json, users.json
 * - Each channel has a subdirectory with dated JSON files (YYYY-MM-DD.json)
 * - Each JSON file is an array of message objects
 *
 * Produces a ParsedDocument with messages grouped by conversation thread.
 * Filters out bot messages, join/leave events, and noise.
 */

import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join, basename } from "path";
import type { ParsedDocument, ParsedSection } from "./types";

// ---------------------------------------------------------------------------
// Slack JSON types (subset of the export schema)
// ---------------------------------------------------------------------------

interface SlackUser {
	readonly id: string;
	readonly name: string;
	readonly real_name?: string;
	readonly profile?: {
		readonly display_name?: string;
		readonly real_name?: string;
	};
	readonly is_bot?: boolean;
}

interface SlackChannel {
	readonly id: string;
	readonly name: string;
	readonly purpose?: { readonly value?: string };
	readonly topic?: { readonly value?: string };
}

interface SlackReaction {
	readonly name: string;
	readonly users: readonly string[];
	readonly count: number;
}

interface SlackMessage {
	readonly type?: string;
	readonly subtype?: string;
	readonly user?: string;
	readonly bot_id?: string;
	readonly text: string;
	readonly ts: string;
	readonly thread_ts?: string;
	readonly reply_count?: number;
	readonly reactions?: readonly SlackReaction[];
	readonly files?: ReadonlyArray<{ readonly name?: string; readonly title?: string }>;
	readonly attachments?: ReadonlyArray<{ readonly fallback?: string; readonly text?: string }>;
}

// ---------------------------------------------------------------------------
// Subtypes to filter out (noise)
// ---------------------------------------------------------------------------

const SKIP_SUBTYPES = new Set([
	"channel_join",
	"channel_leave",
	"channel_topic",
	"channel_purpose",
	"channel_name",
	"channel_archive",
	"channel_unarchive",
	"group_join",
	"group_leave",
	"group_topic",
	"group_purpose",
	"group_name",
	"group_archive",
	"group_unarchive",
	"pinned_item",
	"unpinned_item",
	"bot_add",
	"bot_remove",
	"tombstone",
	"file_comment",
	"sh_room_created",
	"sh_room_shared",
]);

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Parse a Slack export directory into a ParsedDocument.
 *
 * The directory should contain:
 * - users.json (optional but recommended)
 * - channels.json (optional)
 * - One subdirectory per channel, each containing YYYY-MM-DD.json files
 *
 * @param dirPath - Path to the Slack export root directory
 * @param options - Optional filtering
 */
export function parseSlackExport(
	dirPath: string,
	options?: {
		/** Only include these channels */
		readonly channels?: string[];
		/** Only include messages after this date */
		readonly since?: string;
		/** Only include messages before this date */
		readonly until?: string;
		/** Filter to specific speakers */
		readonly speakers?: string[];
	},
): ParsedDocument {
	// Load user directory for name resolution
	const users = loadUsers(dirPath);

	// Load channel metadata
	const channels = loadChannels(dirPath);

	// Find channel directories
	const channelDirs = findChannelDirs(dirPath);

	// Filter channels if requested
	const targetChannels = options?.channels
		? channelDirs.filter((d) => options.channels!.includes(basename(d)))
		: channelDirs;

	const allSections: ParsedSection[] = [];
	let totalChars = 0;
	let totalMessages = 0;

	for (const channelDir of targetChannels) {
		const channelName = basename(channelDir);
		const channelMeta = channels.get(channelName);

		// Load all messages from this channel
		const messages = loadChannelMessages(channelDir);

		// Filter by date range
		const filtered = filterMessages(messages, users, options);

		if (filtered.length === 0) continue;

		// Group into conversation threads
		const threads = groupIntoThreads(filtered);

		// Convert threads to sections
		for (const thread of threads) {
			const section = threadToSection(thread, channelName, users);
			if (section) {
				allSections.push(section);
				totalChars += section.content.length;
				totalMessages += thread.messages.length;
			}
		}
	}

	// Build channel list for metadata
	const channelNames = targetChannels.map((d) => basename(d));

	return {
		format: "slack_json",
		title: `Slack Export (${channelNames.length} channels, ${totalMessages} messages)`,
		sections: allSections,
		metadata: {
			sourceType: "chat_export",
			platform: "slack",
			channelCount: channelNames.length,
			channelNames,
			messageCount: totalMessages,
			userCount: users.size,
		},
		totalChars,
	};
}

// ---------------------------------------------------------------------------
// User loading
// ---------------------------------------------------------------------------

function loadUsers(dirPath: string): Map<string, string> {
	const usersMap = new Map<string, string>();
	const usersPath = join(dirPath, "users.json");

	if (!existsSync(usersPath)) return usersMap;

	try {
		const raw = JSON.parse(readFileSync(usersPath, "utf-8"));
		if (!Array.isArray(raw)) return usersMap;
		const users_arr = raw.filter(
			(u: unknown): u is SlackUser =>
				typeof u === "object" && u !== null && "id" in u && "name" in u,
		);
		for (const user of users_arr) {
			const displayName =
				user.profile?.display_name ||
				user.profile?.real_name ||
				user.real_name ||
				user.name ||
				user.id;
			usersMap.set(user.id, displayName);
		}
	} catch {
		// users.json might be malformed — proceed without user resolution
	}

	return usersMap;
}

// ---------------------------------------------------------------------------
// Channel metadata loading
// ---------------------------------------------------------------------------

function loadChannels(dirPath: string): Map<string, SlackChannel> {
	const channelsMap = new Map<string, SlackChannel>();
	const channelsPath = join(dirPath, "channels.json");

	if (!existsSync(channelsPath)) return channelsMap;

	try {
		const raw = JSON.parse(readFileSync(channelsPath, "utf-8"));
		if (!Array.isArray(raw)) return channelsMap;
		const channels_arr = raw.filter(
			(c: unknown): c is SlackChannel =>
				typeof c === "object" && c !== null && "id" in c && "name" in c,
		);
		for (const ch of channels_arr) {
			channelsMap.set(ch.name, ch);
		}
	} catch {
		// channels.json might be malformed
	}

	return channelsMap;
}

// ---------------------------------------------------------------------------
// Find channel directories
// ---------------------------------------------------------------------------

function findChannelDirs(dirPath: string): string[] {
	const entries = readdirSync(dirPath, { withFileTypes: true });
	const dirs: string[] = [];

	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		// Skip hidden directories and metadata files
		if (entry.name.startsWith(".")) continue;

		const fullPath = join(dirPath, entry.name);
		// Verify it contains .json files (a real channel dir)
		const files = readdirSync(fullPath);
		if (files.some((f) => f.endsWith(".json"))) {
			dirs.push(fullPath);
		}
	}

	return dirs.sort();
}

// ---------------------------------------------------------------------------
// Load messages from a channel directory
// ---------------------------------------------------------------------------

function loadChannelMessages(channelDir: string): SlackMessage[] {
	const files = readdirSync(channelDir)
		.filter((f) => f.endsWith(".json"))
		.sort(); // YYYY-MM-DD.json sorts chronologically

	const messages: SlackMessage[] = [];

	for (const file of files) {
		try {
			const raw = JSON.parse(readFileSync(join(channelDir, file), "utf-8"));
			if (Array.isArray(raw)) {
				messages.push(...raw);
			}
		} catch {
			// Skip malformed files
		}
	}

	return messages;
}

// ---------------------------------------------------------------------------
// Filter messages
// ---------------------------------------------------------------------------

function filterMessages(
	messages: SlackMessage[],
	users: Map<string, string>,
	options?: {
		readonly since?: string;
		readonly until?: string;
		readonly speakers?: string[];
	},
): SlackMessage[] {
	return messages.filter((msg) => {
		// Skip non-messages
		if (msg.type && msg.type !== "message") return false;

		// Skip noise subtypes
		if (msg.subtype && SKIP_SUBTYPES.has(msg.subtype)) return false;

		// Skip bot messages (unless they have substantive content)
		if (msg.bot_id && !msg.text?.trim()) return false;
		if (msg.subtype === "bot_message" && (!msg.text || msg.text.length < 20)) return false;

		// Skip empty messages
		if (!msg.text?.trim()) return false;

		// Date range filter
		if (options?.since || options?.until) {
			const msgDate = tsToDate(msg.ts);
			if (options.since && msgDate < options.since) return false;
			if (options.until && msgDate > options.until) return false;
		}

		// Speaker filter
		if (options?.speakers && msg.user) {
			const userName = users.get(msg.user) || msg.user;
			const userId = msg.user; // guarded by `&& msg.user` above
			if (!options.speakers.some((s) =>
				s.toLowerCase() === userName.toLowerCase() ||
				s.toLowerCase() === userId.toLowerCase()
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
	readonly messages: SlackMessage[];
	readonly startTs: string;
	readonly endTs: string;
}

/** Time gap threshold for splitting unthreaded messages (30 minutes) */
const TIME_GAP_MS = 30 * 60 * 1000;

function groupIntoThreads(messages: SlackMessage[]): ConversationThread[] {
	// Sort by timestamp
	const sorted = [...messages].sort((a, b) =>
		parseFloat(a.ts) - parseFloat(b.ts)
	);

	// Group by explicit thread_ts first
	const threadMap = new Map<string, SlackMessage[]>();
	const unthreaded: SlackMessage[] = [];

	for (const msg of sorted) {
		if (msg.thread_ts && msg.thread_ts !== msg.ts) {
			// This is a reply in a thread
			const list = threadMap.get(msg.thread_ts) ?? [];
			list.push(msg);
			threadMap.set(msg.thread_ts, list);
		} else if (msg.thread_ts === msg.ts && msg.reply_count && msg.reply_count > 0) {
			// This is a thread parent
			const list = threadMap.get(msg.ts) ?? [];
			list.unshift(msg);
			threadMap.set(msg.ts, list);
		} else {
			unthreaded.push(msg);
		}
	}

	const threads: ConversationThread[] = [];

	// Convert explicit threads
	for (const [threadTs, msgs] of threadMap) {
		if (msgs.length === 0) continue;
		threads.push({
			threadId: `thread-${threadTs}`,
			messages: msgs,
			startTs: msgs[0].ts,
			endTs: msgs[msgs.length - 1].ts,
		});
	}

	// Group unthreaded messages by time proximity
	let currentBatch: SlackMessage[] = [];

	for (const msg of unthreaded) {
		if (currentBatch.length > 0) {
			const lastTs = parseFloat(currentBatch[currentBatch.length - 1].ts) * 1000;
			const currentTs = parseFloat(msg.ts) * 1000;

			if (currentTs - lastTs > TIME_GAP_MS) {
				// Time gap — flush current batch
				threads.push({
					threadId: `conv-${currentBatch[0].ts}`,
					messages: currentBatch,
					startTs: currentBatch[0].ts,
					endTs: currentBatch[currentBatch.length - 1].ts,
				});
				currentBatch = [];
			}
		}
		currentBatch.push(msg);
	}

	if (currentBatch.length > 0) {
		threads.push({
			threadId: `conv-${currentBatch[0].ts}`,
			messages: currentBatch,
			startTs: currentBatch[0].ts,
			endTs: currentBatch[currentBatch.length - 1].ts,
		});
	}

	// Sort threads chronologically
	return threads.sort((a, b) => parseFloat(a.startTs) - parseFloat(b.startTs));
}

// ---------------------------------------------------------------------------
// Convert thread to section
// ---------------------------------------------------------------------------

function threadToSection(
	thread: ConversationThread,
	channelName: string,
	users: Map<string, string>,
): ParsedSection | null {
	const lines: string[] = [];

	for (const msg of thread.messages) {
		const speaker = msg.user ? (users.get(msg.user) || msg.user) : "Unknown";
		const timestamp = tsToIsoShort(msg.ts);
		const text = resolveUserMentions(msg.text, users);

		lines.push(`[${timestamp}] ${speaker}: ${text}`);

		// Include file attachments as context
		if (msg.files && msg.files.length > 0) {
			const fileNames = msg.files
				.map((f) => f.title || f.name || "attachment")
				.join(", ");
			lines.push(`  📎 Attachments: ${fileNames}`);
		}

		// Include substantive attachment text
		if (msg.attachments) {
			for (const att of msg.attachments) {
				if (att.text && att.text.length > 20) {
					lines.push(`  > ${att.text.slice(0, 500)}`);
				}
			}
		}
	}

	const content = lines.join("\n");
	if (content.length < 30) return null; // Skip trivially short threads

	const startDate = tsToIsoShort(thread.startTs);
	const heading = `#${channelName} — ${startDate} (${thread.messages.length} messages)`;

	return {
		heading,
		depth: 2,
		content,
		contentType: "text",
	};
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Convert Slack ts (e.g. "1708012345.678900") to ISO date string */
function tsToDate(ts: string): string {
	const seconds = parseFloat(ts);
	return new Date(seconds * 1000).toISOString().slice(0, 10);
}

/** Convert Slack ts to short ISO timestamp (YYYY-MM-DD HH:mm) */
function tsToIsoShort(ts: string): string {
	const seconds = parseFloat(ts);
	return new Date(seconds * 1000).toISOString().slice(0, 16).replace("T", " ");
}

/** Replace <@U12345> mentions with actual names */
function resolveUserMentions(text: string, users: Map<string, string>): string {
	return text.replace(/<@(U[A-Z0-9]+)>/g, (_, userId) => {
		const name = users.get(userId);
		return name ? `@${name}` : `@${userId}`;
	});
}
