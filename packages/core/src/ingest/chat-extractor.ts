/**
 * Conversation-Aware Extraction for the ingestion engine.
 *
 * Specialized extraction logic for chat/conversation content.
 * Different from document extraction:
 * - Tracks speaker attribution
 * - Extracts decisions, action items, preferences
 * - Filters out greetings, casual banter, meta-conversation
 * - Understands conversational context (agreements, disagreements)
 *
 * Uses the same Ollama-based extraction as the document extractor
 * but with a conversation-specific prompt.
 */

import type { ChunkResult, ExtractionResult } from "./types";
import {
	callOllama as sharedCallOllama,
	parseExtractionResponse as sharedParseExtractionResponse,
	type ParseOptions,
} from "./ollama-client";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

export interface ChatExtractorConfig {
	/** Ollama base URL */
	readonly ollamaUrl: string;
	/** Model to use for extraction */
	readonly model: string;
	/** Request timeout in ms */
	readonly timeoutMs: number;
	/** Minimum confidence to keep an extracted item */
	readonly minConfidence: number;
}

export const DEFAULT_CHAT_EXTRACTOR_CONFIG: ChatExtractorConfig = {
	ollamaUrl: "http://localhost:11434",
	model: "llama3.2",
	timeoutMs: 120_000,
	minConfidence: 0.5,
};

// ---------------------------------------------------------------------------
// Conversation Extraction Prompt
// ---------------------------------------------------------------------------

function buildConversationExtractionPrompt(
	conversationText: string,
	channelName: string | null,
	participants: string[],
): string {
	const contextParts: string[] = [];
	if (channelName) contextParts.push(`Channel: #${channelName}`);
	if (participants.length > 0) contextParts.push(`Participants: ${participants.join(", ")}`);
	const contextBlock = contextParts.length > 0
		? `${contextParts.join("\n")}\n\n`
		: "";

	return `You are a precision knowledge extraction engine analyzing a conversation transcript.

${contextBlock}TASK: Extract DECISIONS, ACTION ITEMS, KEY INFORMATION, PREFERENCES, and RELATIONSHIPS from this conversation.

Each item must be:
1. SELF-CONTAINED — fully understandable without the original conversation
2. ATTRIBUTED — include WHO said/decided it when clear
3. DURABLE — information that stays useful over time
4. SPECIFIC — include concrete names, dates, tools, URLs when present

Return a JSON object with "items" and "relations" arrays.

ITEM SCHEMA:
{"content": "<self-contained statement with speaker attribution>", "type": "<type>", "confidence": <0.0-1.0>, "speaker": "<name or null>"}

TYPES (use exactly these strings):
- "decision" — A choice that was made or agreed upon in the conversation
- "fact" — Key information shared (specs, dates, endpoints, credentials)
- "preference" — Expressed likes/dislikes, style preferences, tool preferences
- "procedural" — Processes or workflows discussed ("To deploy, run X then Y")
- "rationale" — Reasoning behind a decision ("We chose X because Y")
- "system" — Technical config: ports, URLs, env vars, API keys mentioned
- "semantic" — Definitions, explanations, mental models shared

The "speaker" field should be the NAME of the person who stated/decided this. Use null ONLY if genuinely unclear.

RELATION SCHEMA (connections between people, projects, tools):
{"source": "<entity>", "relationship": "<verb phrase>", "target": "<entity>", "confidence": <0.0-1.0>}

QUALITY RULES:
- Merge the question + answer into ONE item (don't extract the question separately)
- For decisions, include WHAT was decided AND the alternative if mentioned
- For action items, include WHO will do WHAT and WHEN if specified
- Include relevant context that makes the item self-contained
- Attribute to the decision-maker, not just the person who asked

SKIP ENTIRELY:
- Greetings ("hi", "good morning", "hey", "what's up")
- Casual reactions ("lol", "haha", "nice", "cool", "👍")
- Meta-conversation ("can you see my screen?", "are you there?", "brb")
- Acknowledgments without information ("ok", "got it", "sounds good")
- Repeated information (extract once, not every time it's mentioned)
- Questions that were never answered
- Small talk and banter without informational content

EXAMPLES:

Conversation:
[10:30] Alice: should we use Postgres or MySQL for the new service?
[10:32] Bob: Postgres has better JSON support and we already run it
[10:33] Alice: agreed, let's go with Postgres

Extraction:
{"items": [
  {"content": "Alice and Bob decided to use Postgres over MySQL for the new service because Postgres has better JSON support and is already in use", "type": "decision", "confidence": 0.9, "speaker": "Alice"},
  {"content": "The existing infrastructure already runs Postgres", "type": "fact", "confidence": 0.8, "speaker": "Bob"}
], "relations": [
  {"source": "new service", "relationship": "uses", "target": "Postgres", "confidence": 0.9}
]}

Conversation:
[14:00] Charlie: I'll have the API docs ready by Friday
[14:01] Dave: great, I need them before I can start the frontend integration
[14:02] Charlie: also, the staging endpoint is api.staging.example.com

Extraction:
{"items": [
  {"content": "Charlie committed to having API docs ready by Friday", "type": "decision", "confidence": 0.85, "speaker": "Charlie"},
  {"content": "Dave is blocked on frontend integration until API docs are ready", "type": "fact", "confidence": 0.8, "speaker": "Dave"},
  {"content": "The staging API endpoint is api.staging.example.com", "type": "system", "confidence": 0.95, "speaker": "Charlie"}
], "relations": [
  {"source": "Dave", "relationship": "blocked_by", "target": "API docs", "confidence": 0.8},
  {"source": "Charlie", "relationship": "responsible_for", "target": "API docs", "confidence": 0.85}
]}

Return ONLY valid JSON. No markdown fences, no explanation.
If there is nothing worth extracting, return: {"items": [], "relations": []}

CONVERSATION:
${conversationText}`;
}

// ---------------------------------------------------------------------------
// Code Context Extraction Prompt (for code discussions in chat)
// ---------------------------------------------------------------------------

function buildCodeDiscussionPrompt(
	conversationText: string,
	channelName: string | null,
): string {
	const channelStr = channelName ? `Channel: #${channelName}\n\n` : "";

	return `You are a knowledge extraction engine analyzing a technical discussion about code and architecture.

${channelStr}TASK: Extract ARCHITECTURE DECISIONS, TECHNICAL SPECS, and CODE PATTERNS from this conversation.

Return a JSON object with "items" and "relations" arrays.

ITEM SCHEMA:
{"content": "<self-contained technical statement>", "type": "<type>", "confidence": <0.0-1.0>, "speaker": "<name or null>"}

Focus on:
- Architecture decisions ("let's use X pattern for Y")
- Technical specifications ("the API returns X format")
- Configuration values ("port 8080", "Redis on localhost:6379")
- Bug patterns and fixes ("X crashes when Y, fixed by Z")
- Design rationale ("we use pub/sub because polling was too slow")
- Deployment/infrastructure decisions

Return ONLY valid JSON.

CONVERSATION:
${conversationText}`;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Extract knowledge from a conversation chunk using an LLM.
 *
 * This is the conversation-specific equivalent of the document extractor.
 * It uses a prompt tailored for conversational content with speaker attribution.
 */
export async function extractFromConversation(
	chunk: ChunkResult,
	channelName: string | null,
	participants: string[],
	config: ChatExtractorConfig = DEFAULT_CHAT_EXTRACTOR_CONFIG,
): Promise<ExtractionResult> {
	// Detect if this is a code-heavy conversation
	const isCodeDiscussion = detectCodeDiscussion(chunk.text);

	const prompt = isCodeDiscussion
		? buildCodeDiscussionPrompt(chunk.text, channelName)
		: buildConversationExtractionPrompt(chunk.text, channelName, participants);

	try {
		const response = await callOllama(prompt, config);
		const parsed = parseExtractionResponse(response, config.minConfidence);

		return {
			chunkIndex: chunk.index,
			items: parsed.items,
			relations: parsed.relations,
			warnings: parsed.warnings,
		};
	} catch (err) {
		const msg = err instanceof Error ? err.message : String(err);
		return {
			chunkIndex: chunk.index,
			items: [],
			relations: [],
			warnings: [`Chat extraction failed for chunk ${chunk.index}: ${msg}`],
		};
	}
}

/**
 * Extract knowledge from all conversation chunks.
 */
export async function extractFromConversations(
	chunks: readonly ChunkResult[],
	channelName: string | null,
	participants: string[],
	config: ChatExtractorConfig = DEFAULT_CHAT_EXTRACTOR_CONFIG,
	onChunkDone?: (chunkIndex: number, itemCount: number) => void,
): Promise<ExtractionResult[]> {
	const results: ExtractionResult[] = [];

	for (const chunk of chunks) {
		const result = await extractFromConversation(
			chunk,
			channelName,
			participants,
			config,
		);
		results.push(result);
		if (onChunkDone) {
			onChunkDone(chunk.index, result.items.length);
		}
	}

	return results;
}

/**
 * Extract participants from a conversation chunk text.
 * Looks for patterns like "[timestamp] Name: message"
 */
export function extractParticipants(chunkText: string): string[] {
	const speakers = new Set<string>();
	const lines = chunkText.split("\n");

	for (const line of lines) {
		const match = line.match(/^\[.*?\]\s+(.+?):\s/);
		if (match) {
			speakers.add(match[1].replace(/\s*\(replying\)/, ""));
		}
	}

	return [...speakers].sort();
}

// ---------------------------------------------------------------------------
// Code discussion detection
// ---------------------------------------------------------------------------

function detectCodeDiscussion(text: string): boolean {
	const codeIndicators = [
		/```[\s\S]*?```/,          // Code blocks
		/`[^`]+`/,                 // Inline code
		/\b(?:function|class|const|let|var|def|import|export)\b/,
		/\b(?:API|endpoint|database|schema|migration|deploy)\b/i,
		/\b(?:localhost|port \d+|https?:\/\/)\b/,
		/\b(?:npm|yarn|pip|cargo|docker|kubectl)\b/,
	];

	let matches = 0;
	for (const pattern of codeIndicators) {
		if (pattern.test(text)) matches++;
	}

	return matches >= 3;
}

// ---------------------------------------------------------------------------
// Ollama API call — delegates to shared client
// ---------------------------------------------------------------------------

async function callOllama(
	prompt: string,
	config: ChatExtractorConfig,
): Promise<string> {
	return sharedCallOllama(prompt, config);
}

// ---------------------------------------------------------------------------
// Parse LLM response — delegates to shared parser with chat-specific config
// ---------------------------------------------------------------------------

/** Valid types for chat extraction */
const CHAT_VALID_TYPES = new Set([
	"fact", "decision", "rationale", "preference",
	"procedural", "semantic", "system",
]);

/** Map alternative type names to valid ones */
const CHAT_TYPE_MAP: Record<string, string> = {
	configuration: "system",
	architectural: "decision",
	relationship: "fact",
	commitment: "decision",
	"action-item": "decision",
	"action_item": "decision",
};

function parseExtractionResponse(
	raw: string,
	minConfidence: number,
) {
	const opts: ParseOptions = {
		minConfidence,
		validTypes: CHAT_VALID_TYPES,
		typeMap: CHAT_TYPE_MAP,
		defaultType: "fact",
		minContentLength: 15,
	};
	return sharedParseExtractionResponse(raw, opts);
}
