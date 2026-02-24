/**
 * Entire.io Session Parser for the ingestion engine.
 *
 * Parses Entire checkpoint data stored on the `entire/checkpoints/v1`
 * shadow branch WITHOUT checking it out. Extracts:
 * - Session transcripts (full prompt→response conversations)
 * - Files touched per session
 * - Checkpoint metadata (timestamps, commit links, strategy)
 * - Agent info (Claude Code, Gemini CLI, etc.)
 *
 * Entire stores checkpoints in a sharded path structure on the branch:
 *   <checkpoint-id[:2]>/<checkpoint-id[2:]>/
 *   ├── metadata.json         (CheckpointSummary: aggregated stats, sessions list)
 *   ├── 1/                    (session subdirectory)
 *   │   ├── metadata.json     (CommittedMetadata: session-specific details)
 *   │   ├── full.jsonl        (transcript in JSONL format)
 *   │   ├── prompt.txt        (user prompts)
 *   │   └── context.md        (generated context)
 *   └── 2/ ...
 *
 * The JSONL transcript format has lines like:
 *   {"uuid":"...","type":"user","message":{"content":"..."},"timestamp":"..."}
 *   {"uuid":"...","type":"assistant","message":{"content":[{"type":"text","text":"..."}]},"timestamp":"..."}
 */

import { existsSync } from "fs";
import { join } from "path";
import { execFileSync } from "child_process";
import type { ParsedDocument, ParsedSection } from "./types";
import { findGit } from "./git-utils";

// ---------------------------------------------------------------------------
// Branch name (matches Entire CLI's paths.MetadataBranchName)
// ---------------------------------------------------------------------------

const ENTIRE_BRANCH = "entire/checkpoints/v1";

/** Max characters to read from a single transcript */
const MAX_TRANSCRIPT_CHARS = 200_000;

// ---------------------------------------------------------------------------
// Types matching Entire's on-branch JSON schema
// ---------------------------------------------------------------------------

/** Root-level metadata.json for a checkpoint (CheckpointSummary) */
interface EntireCheckpointSummary {
	readonly checkpoint_id: string;
	readonly cli_version?: string;
	readonly strategy?: string;
	readonly branch?: string;
	readonly checkpoints_count?: number;
	readonly files_touched?: string[];
	readonly sessions?: EntireSessionFilePaths[];
	readonly token_usage?: EntireTokenUsage | null;
}

/** Paths to session files within the checkpoint directory */
interface EntireSessionFilePaths {
	readonly metadata?: string;
	readonly transcript?: string;
	readonly prompt?: string;
	readonly context?: string;
	readonly content_hash?: string;
}

/** Session-level metadata.json (CommittedMetadata) */
interface EntireSessionMetadata {
	readonly checkpoint_id: string;
	readonly session_id: string;
	readonly strategy?: string;
	readonly created_at?: string;
	readonly branch?: string;
	readonly checkpoints_count?: number;
	readonly files_touched?: string[];
	readonly agent?: string;
	readonly turn_id?: string;
	readonly is_task?: boolean;
	readonly tool_use_id?: string;
	readonly transcript_identifier_at_start?: string;
	readonly checkpoint_transcript_start?: number;
	readonly token_usage?: EntireTokenUsage | null;
	readonly summary?: EntireSummary | null;
	readonly initial_attribution?: EntireAttribution | null;
}

/** AI-generated summary stored in session metadata */
interface EntireSummary {
	readonly intent?: string;
	readonly outcome?: string;
	readonly learnings?: {
		readonly repo?: string[];
		readonly code?: Array<{ path?: string; finding?: string }>;
		readonly workflow?: string[];
	};
	readonly friction?: string[];
	readonly open_items?: string[];
}

interface EntireTokenUsage {
	readonly input_tokens?: number;
	readonly cache_creation_tokens?: number;
	readonly cache_read_tokens?: number;
	readonly output_tokens?: number;
	readonly api_call_count?: number;
}

interface EntireAttribution {
	readonly agent_lines?: number;
	readonly human_added?: number;
	readonly human_modified?: number;
	readonly human_removed?: number;
	readonly total_committed?: number;
	readonly agent_percentage?: number;
}

/** A single line in a JSONL transcript */
interface TranscriptLine {
	readonly uuid?: string;
	readonly type?: string; // "user" | "assistant"
	readonly message?: unknown;
	readonly timestamp?: string;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Check if a repository has Entire.io checkpoint data.
 *
 * @param repoPath - Path to the git repository root
 * @returns true if the `entire/checkpoints/v1` branch exists
 */
export function hasEntireBranch(repoPath: string): boolean {
	if (!existsSync(join(repoPath, ".git"))) {
		return false;
	}

	try {
		const gitPath = findGit();
		if (!gitPath) return false;

		execFileSync(gitPath, [
			"-C", repoPath,
			"rev-parse", "--verify", ENTIRE_BRANCH,
		], {
			encoding: "utf-8",
			timeout: 10_000,
			stdio: ["pipe", "pipe", "pipe"],
		});
		return true;
	} catch {
		return false;
	}
}

/**
 * Parse Entire.io sessions from a git repository.
 *
 * Reads the `entire/checkpoints/v1` branch without checking it out
 * and extracts all session transcripts, metadata, and file change info.
 *
 * @param repoPath - Path to the repository root (must have .git/)
 * @param options - Optional configuration
 * @returns ParsedDocument with sections per session
 */
export function parseEntireRepo(
	repoPath: string,
	options?: {
		/** Maximum number of sessions to parse (default: all) */
		readonly maxSessions?: number;
		/** Only include sessions after this date */
		readonly since?: string;
		/** Include raw transcript text in sections (default: true) */
		readonly includeTranscripts?: boolean;
	},
): ParsedDocument {
	const sections: ParsedSection[] = [];
	let totalChars = 0;
	const includeTranscripts = options?.includeTranscripts !== false;

	const gitPath = findGit();
	if (!gitPath) {
		return emptyDoc("Could not find git executable");
	}

	// Verify the branch exists
	if (!hasEntireBranch(repoPath)) {
		return emptyDoc("No entire/checkpoints/v1 branch found");
	}

	// List all files on the branch
	let fileList: string[];
	try {
		const output = execFileSync(gitPath, [
			"-C", repoPath,
			"ls-tree", "-r", "--name-only", ENTIRE_BRANCH,
		], {
			encoding: "utf-8",
			timeout: 30_000,
			maxBuffer: 10 * 1024 * 1024,
		});
		fileList = output.trim().split("\n").filter(Boolean);
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return emptyDoc(`Failed to list files on ${ENTIRE_BRANCH}: ${msg}`);
	}

	// Find all checkpoint root metadata files (sharded: XX/YYYYYYYYYY/metadata.json)
	const checkpointMetadataFiles = fileList.filter((f) =>
		f.match(/^[0-9a-f]{2}\/[0-9a-f]+\/metadata\.json$/),
	);

	if (checkpointMetadataFiles.length === 0) {
		return emptyDoc("No checkpoints found on entire/checkpoints/v1 branch");
	}

	// Parse each checkpoint
	const allSessions: Array<{
		checkpointId: string;
		sessionMeta: EntireSessionMetadata;
		transcriptText: string;
		promptText: string;
		contextText: string;
	}> = [];

	for (const metaFile of checkpointMetadataFiles) {
		try {
			const summaryRaw = gitShow(gitPath, repoPath, metaFile);
			const summary: EntireCheckpointSummary = JSON.parse(summaryRaw);

			if (!summary.sessions || summary.sessions.length === 0) continue;

			const checkpointDir = metaFile.replace(/\/metadata\.json$/, "");

			// Parse each session within the checkpoint
			for (let i = 0; i < summary.sessions.length; i++) {
				const sessionDir = `${checkpointDir}/${i}`;

				// Read session metadata
				let sessionMeta: EntireSessionMetadata;
				try {
					const sessionMetaRaw = gitShow(gitPath, repoPath, `${sessionDir}/metadata.json`);
					sessionMeta = JSON.parse(sessionMetaRaw);
				} catch {
					continue; // Skip sessions with unreadable metadata
				}

				// Apply date filter
				if (options?.since && sessionMeta.created_at) {
					const sessionDate = new Date(sessionMeta.created_at);
					const sinceDate = new Date(options.since);
					if (sessionDate < sinceDate) continue;
				}

				// Read transcript (full.jsonl, possibly chunked)
				let transcriptText = "";
				if (includeTranscripts) {
					transcriptText = readTranscript(gitPath, repoPath, sessionDir, fileList);
				}

				// Read prompt
				let promptText = "";
				try {
					promptText = gitShow(gitPath, repoPath, `${sessionDir}/prompt.txt`);
				} catch { /* no prompt file */ }

				// Read context
				let contextText = "";
				try {
					contextText = gitShow(gitPath, repoPath, `${sessionDir}/context.md`);
				} catch { /* no context file */ }

				allSessions.push({
					checkpointId: summary.checkpoint_id || checkpointDir,
					sessionMeta,
					transcriptText,
					promptText,
					contextText,
				});
			}
		} catch {
			// Skip unparseable checkpoints
		}
	}

	// Sort sessions by creation time (most recent first for relevance)
	allSessions.sort((a, b) => {
		const dateA = a.sessionMeta.created_at ? new Date(a.sessionMeta.created_at).getTime() : 0;
		const dateB = b.sessionMeta.created_at ? new Date(b.sessionMeta.created_at).getTime() : 0;
		return dateB - dateA;
	});

	// Apply maxSessions limit
	const sessionsToParse = options?.maxSessions
		? allSessions.slice(0, options.maxSessions)
		: allSessions;

	// Build overview section
	const overviewLines = [
		`Entire.io session data from ${allSessions.length} checkpoint sessions`,
		`Branch: ${ENTIRE_BRANCH}`,
		"",
	];

	// Aggregate agent types
	const agentTypes = new Set<string>();
	for (const s of allSessions) {
		if (s.sessionMeta.agent) agentTypes.add(s.sessionMeta.agent);
	}
	if (agentTypes.size > 0) {
		overviewLines.push(`Agents detected: ${[...agentTypes].join(", ")}`);
	}

	// Aggregate strategies
	const strategies = new Set<string>();
	for (const s of allSessions) {
		if (s.sessionMeta.strategy) strategies.add(s.sessionMeta.strategy);
	}
	if (strategies.size > 0) {
		overviewLines.push(`Strategies: ${[...strategies].join(", ")}`);
	}

	// Aggregate files touched
	const allFiles = new Set<string>();
	for (const s of allSessions) {
		if (s.sessionMeta.files_touched) {
			for (const f of s.sessionMeta.files_touched) allFiles.add(f);
		}
	}
	if (allFiles.size > 0) {
		overviewLines.push(`Total unique files touched: ${allFiles.size}`);
	}

	const overviewContent = overviewLines.join("\n");
	sections.push({
		heading: "Entire.io Session Overview",
		depth: 1,
		content: overviewContent,
		contentType: "text",
	});
	totalChars += overviewContent.length;

	// Build per-session sections
	for (const session of sessionsToParse) {
		const meta = session.sessionMeta;
		const sessionSections = buildSessionSections(session, meta);

		for (const section of sessionSections) {
			sections.push(section);
			totalChars += section.content.length;
		}
	}

	return {
		format: "entire_sessions",
		title: `Entire.io Sessions (${sessionsToParse.length} sessions)`,
		sections,
		metadata: {
			sourceType: "entire_sessions",
			branch: ENTIRE_BRANCH,
			totalSessions: allSessions.length,
			parsedSessions: sessionsToParse.length,
			agents: [...agentTypes],
			strategies: [...strategies],
			totalFilesTouched: allFiles.size,
		},
		totalChars,
	};
}

// ---------------------------------------------------------------------------
// Session section builders
// ---------------------------------------------------------------------------

function buildSessionSections(
	session: {
		checkpointId: string;
		sessionMeta: EntireSessionMetadata;
		transcriptText: string;
		promptText: string;
		contextText: string;
	},
	meta: EntireSessionMetadata,
): ParsedSection[] {
	const sections: ParsedSection[] = [];
	const sessionLabel = `Session ${meta.session_id || session.checkpointId}`;
	const dateStr = meta.created_at
		? new Date(meta.created_at).toISOString().slice(0, 19).replace("T", " ")
		: "unknown date";

	// Session metadata section
	const metaLines: string[] = [
		`Checkpoint: ${session.checkpointId}`,
		`Session ID: ${meta.session_id || "unknown"}`,
		`Date: ${dateStr}`,
	];

	if (meta.agent) metaLines.push(`Agent: ${meta.agent}`);
	if (meta.strategy) metaLines.push(`Strategy: ${meta.strategy}`);
	if (meta.branch) metaLines.push(`Branch: ${meta.branch}`);
	if (meta.is_task) metaLines.push(`Type: Task checkpoint`);

	if (meta.files_touched && meta.files_touched.length > 0) {
		metaLines.push(`Files touched (${meta.files_touched.length}):`);
		for (const f of meta.files_touched.slice(0, 50)) {
			metaLines.push(`  - ${f}`);
		}
		if (meta.files_touched.length > 50) {
			metaLines.push(`  ... and ${meta.files_touched.length - 50} more`);
		}
	}

	if (meta.token_usage) {
		const tu = meta.token_usage;
		const parts: string[] = [];
		if (tu.input_tokens) parts.push(`input: ${tu.input_tokens}`);
		if (tu.output_tokens) parts.push(`output: ${tu.output_tokens}`);
		if (tu.cache_read_tokens) parts.push(`cache_read: ${tu.cache_read_tokens}`);
		if (tu.api_call_count) parts.push(`api_calls: ${tu.api_call_count}`);
		if (parts.length > 0) metaLines.push(`Token usage: ${parts.join(", ")}`);
	}

	if (meta.initial_attribution) {
		const attr = meta.initial_attribution;
		metaLines.push(`Attribution: ${attr.agent_percentage?.toFixed(1) ?? "?"}% agent (${attr.agent_lines ?? 0} agent lines, ${attr.human_added ?? 0} human added, ${attr.human_modified ?? 0} human modified)`);
	}

	if (meta.summary) {
		if (meta.summary.intent) metaLines.push(`Intent: ${meta.summary.intent}`);
		if (meta.summary.outcome) metaLines.push(`Outcome: ${meta.summary.outcome}`);
		if (meta.summary.friction && meta.summary.friction.length > 0) {
			metaLines.push(`Friction: ${meta.summary.friction.join("; ")}`);
		}
		if (meta.summary.open_items && meta.summary.open_items.length > 0) {
			metaLines.push(`Open items: ${meta.summary.open_items.join("; ")}`);
		}
		if (meta.summary.learnings) {
			const l = meta.summary.learnings;
			if (l.repo && l.repo.length > 0) {
				metaLines.push(`Repo learnings: ${l.repo.join("; ")}`);
			}
			if (l.workflow && l.workflow.length > 0) {
				metaLines.push(`Workflow learnings: ${l.workflow.join("; ")}`);
			}
			if (l.code && l.code.length > 0) {
				for (const c of l.code.slice(0, 10)) {
					metaLines.push(`Code learning [${c.path || "?"}]: ${c.finding || ""}`);
				}
			}
		}
	}

	sections.push({
		heading: `${sessionLabel} — Metadata (${dateStr})`,
		depth: 2,
		content: metaLines.join("\n"),
		contentType: "text",
	});

	// Transcript section — convert JSONL to readable conversation
	if (session.transcriptText) {
		const conversationText = transcriptToConversation(session.transcriptText);
		if (conversationText.length > 0) {
			sections.push({
				heading: `${sessionLabel} — Transcript`,
				depth: 2,
				content: conversationText.slice(0, MAX_TRANSCRIPT_CHARS),
				contentType: "text",
			});
		}
	}

	// Prompt section (if separate from transcript)
	if (session.promptText && session.promptText.trim().length > 50) {
		sections.push({
			heading: `${sessionLabel} — Prompts`,
			depth: 3,
			content: session.promptText.trim(),
			contentType: "text",
		});
	}

	return sections;
}

// ---------------------------------------------------------------------------
// Transcript JSONL → readable conversation
// ---------------------------------------------------------------------------

/**
 * Convert JSONL transcript to a human-readable conversation format.
 * Each line is a JSON object with { type, uuid, message, timestamp }.
 */
function transcriptToConversation(jsonlText: string): string {
	const lines = jsonlText.trim().split("\n");
	const parts: string[] = [];

	for (const line of lines) {
		if (!line.trim()) continue;

		let parsed: TranscriptLine;
		try {
			parsed = JSON.parse(line);
		} catch {
			continue;
		}

		if (!parsed.type || !parsed.message) continue;

		if (parsed.type === "user") {
			const userText = extractUserContent(parsed.message);
			if (userText) {
				const ts = parsed.timestamp ? formatTimestamp(parsed.timestamp) : "";
				parts.push(`${ts}[USER]: ${userText}`);
			}
		} else if (parsed.type === "assistant") {
			const assistantTexts = extractAssistantContent(parsed.message);
			const toolUses = extractToolUses(parsed.message);

			for (const text of assistantTexts) {
				const ts = parsed.timestamp ? formatTimestamp(parsed.timestamp) : "";
				parts.push(`${ts}[ASSISTANT]: ${text}`);
			}

			for (const tool of toolUses) {
				const ts = parsed.timestamp ? formatTimestamp(parsed.timestamp) : "";
				parts.push(`${ts}[TOOL:${tool.name}]: ${tool.description}`);
			}
		}
	}

	return parts.join("\n\n");
}

function extractUserContent(message: unknown): string | null {
	if (typeof message !== "object" || message === null) return null;
	const msg = message as Record<string, unknown>;

	// String content (direct user prompt)
	if (typeof msg.content === "string") {
		return msg.content;
	}

	// Array content — could be text blocks or tool_result blocks
	if (Array.isArray(msg.content)) {
		const textParts: string[] = [];
		for (const block of msg.content) {
			if (typeof block === "object" && block !== null) {
				const b = block as Record<string, unknown>;
				if (b.type === "text" && typeof b.text === "string") {
					textParts.push(b.text);
				}
				// Skip tool_result blocks — they're not real user prompts
			}
		}
		if (textParts.length > 0) return textParts.join("\n");
	}

	return null;
}

function extractAssistantContent(message: unknown): string[] {
	const texts: string[] = [];
	if (typeof message !== "object" || message === null) return texts;
	const msg = message as Record<string, unknown>;

	if (!Array.isArray(msg.content)) return texts;

	for (const block of msg.content) {
		if (typeof block === "object" && block !== null) {
			const b = block as Record<string, unknown>;
			if (b.type === "text" && typeof b.text === "string" && b.text.trim()) {
				texts.push(b.text);
			}
		}
	}

	return texts;
}

function extractToolUses(message: unknown): Array<{ name: string; description: string }> {
	const tools: Array<{ name: string; description: string }> = [];
	if (typeof message !== "object" || message === null) return tools;
	const msg = message as Record<string, unknown>;

	if (!Array.isArray(msg.content)) return tools;

	for (const block of msg.content) {
		if (typeof block === "object" && block !== null) {
			const b = block as Record<string, unknown>;
			if (b.type === "tool_use" && typeof b.name === "string") {
				let desc = b.name;
				if (typeof b.input === "object" && b.input !== null) {
					const input = b.input as Record<string, unknown>;
					if (input.file_path) desc += ` → ${input.file_path}`;
					else if (input.command) desc += ` → ${String(input.command).slice(0, 200)}`;
					else if (input.url) desc += ` → ${input.url}`;
					else if (input.prompt) desc += `: ${String(input.prompt).slice(0, 200)}`;
				}
				tools.push({ name: b.name, description: desc });
			}
		}
	}

	return tools;
}

function formatTimestamp(ts: string): string {
	try {
		const d = new Date(ts);
		return `[${d.toISOString().slice(11, 19)}] `;
	} catch {
		return "";
	}
}

// ---------------------------------------------------------------------------
// Git helpers
// ---------------------------------------------------------------------------

/**
 * Read a file from the entire/checkpoints/v1 branch without checkout.
 */
function gitShow(gitPath: string, repoPath: string, filePath: string): string {
	return execFileSync(gitPath, [
		"-C", repoPath,
		"show", `${ENTIRE_BRANCH}:${filePath}`,
	], {
		encoding: "utf-8",
		timeout: 15_000,
		maxBuffer: 10 * 1024 * 1024,
	});
}

/**
 * Read transcript data which may be chunked across multiple files.
 * Entire stores transcripts as full.jsonl or full.jsonl.001, full.jsonl.002, etc.
 */
function readTranscript(
	gitPath: string,
	repoPath: string,
	sessionDir: string,
	fileList: string[],
): string {
	// Look for chunk files first
	const chunkPattern = `${sessionDir}/full.jsonl.`;
	const chunkFiles = fileList
		.filter((f) => f.startsWith(chunkPattern))
		.sort(); // .001, .002, etc. sort lexicographically

	if (chunkFiles.length > 0) {
		// Also check for base file (full.jsonl = chunk 0)
		const baseFile = `${sessionDir}/full.jsonl`;
		const allFiles = fileList.includes(baseFile)
			? [baseFile, ...chunkFiles]
			: chunkFiles;

		const parts: string[] = [];
		for (const file of allFiles) {
			try {
				parts.push(gitShow(gitPath, repoPath, file));
			} catch {
				// Skip unreadable chunks
			}
		}
		return parts.join("\n");
	}

	// Try single transcript file
	try {
		return gitShow(gitPath, repoPath, `${sessionDir}/full.jsonl`);
	} catch {
		// Try legacy filename
		try {
			return gitShow(gitPath, repoPath, `${sessionDir}/full.log`);
		} catch {
			return "";
		}
	}
}

function emptyDoc(reason: string): ParsedDocument {
	return {
		format: "entire_sessions",
		title: "Entire.io Sessions (empty)",
		sections: [{
			heading: "Entire.io Session Data",
			depth: 1,
			content: reason,
			contentType: "text",
		}],
		metadata: {
			sourceType: "entire_sessions",
			empty: true,
			reason,
		},
		totalChars: reason.length,
	};
}
