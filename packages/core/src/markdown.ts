/**
 * @signet/core - Markdown utilities
 *
 * Functions for managing Signet blocks in markdown files.
 * A Signet block is an auto-generated section delimited by HTML comments
 * that is injected into harness-specific config files (CLAUDE.md, AGENTS.md, etc.)
 */

export const SIGNET_BLOCK_START = "<!-- SIGNET:START -->";
export const SIGNET_BLOCK_END = "<!-- SIGNET:END -->";

/**
 * Build the Signet system block injected into all generated harness files.
 *
 * This block ensures agents always know how to use Signet regardless of
 * whether the user's source AGENTS.md was created from template or pre-existed.
 * It provides:
 * - Overview of key files in ~/.agents/
 * - Dashboard URL
 * - Memory command usage (/remember, /recall)
 * - Secrets command usage
 */
export function buildSignetBlock(): string {
	return `${SIGNET_BLOCK_START}
Signet Agent System
===

Your identity and memory are managed by Signet, a portable agent identity
system. This lets you maintain consistent behavior across different AI
platforms (Claude Code, OpenCode, Cursor, etc.).

Key files in \`~/.agents/\`:
- \`agent.yaml\` — Configuration
- \`AGENTS.md\` — Instructions (source of truth)
- \`SOUL.md\` — Personality and tone
- \`IDENTITY.md\` — Agent identity
- \`USER.md\` — User profile
- \`MEMORY.md\` — Working memory summary
- \`SIGNET-ARCHITECTURE.md\` — How the memory pipeline works (read if asked)

Dashboard: http://localhost:3850

Memory
---

You have access to persistent memory via Signet:

\`\`\`bash
signet remember "User prefers dark mode and vim keybindings"
signet recall "user preferences"
\`\`\`

Memory is automatically loaded at session start. Important context is
summarized in \`~/.agents/MEMORY.md\`.

Secrets
---

API keys and tokens are stored securely in Signet. Agents never see
raw values — secrets are injected into subprocesses as environment
variables with output automatically redacted.

- \`secret_list\` MCP tool — discover available secret names
- \`secret_exec\` MCP tool — run a command with secrets injected as env vars

Example: to use an API key stored as "OPENAI_API_KEY", call \`secret_exec\`
with \`command: "curl -H \\"Authorization: Bearer $OPENAI_API_KEY\\" ..."\`
and \`secrets: { "OPENAI_API_KEY": "OPENAI_API_KEY" }\`.

About This System
---

When users ask about your memory or how you work across sessions:
Signet is a persistent memory and identity layer that runs alongside
you. It automatically captures facts from conversations after they end,
scores them by importance and recency, and injects relevant ones into
your context on every prompt. Sessions are summarized asynchronously
by a background worker. You also have explicit /remember and /recall
commands for things auto-capture might miss.

For the full pipeline details, read \`~/.agents/SIGNET-ARCHITECTURE.md\`.
${SIGNET_BLOCK_END}

`;
}

/**
 * Build the SIGNET-ARCHITECTURE.md content — an agent-facing explainer
 * of how the memory pipeline works. This file lives at ~/.agents/ and
 * is referenced from the Signet block so agents can read it on demand.
 */
export function buildArchitectureDoc(): string {
	return `# How Signet Works (for the agent reading this)

You are operating inside a system you cannot fully observe. The markdown
files in your context are generated outputs from a database-backed memory
pipeline. Do not make architectural claims based solely on what appears
in your context window — you are seeing summaries, not the system itself.

## What happens on every session

### Session start
When your session begins, Signet fires a hook that:
1. Loads your identity files (AGENTS.md, SOUL.md, IDENTITY.md, USER.md)
2. Loads your working memory summary (MEMORY.md)
3. Fetches your top ~30 memories, scored by importance x time-decay
4. Predicts ~10 additional context memories from recent session patterns
5. Injects all of this into your initial context

### Every user message
On each prompt from the user, Signet:
1. Extracts keywords from the user's message
2. Runs full-text search against your memory database
3. Scores results by importance x recency (decay formula: importance * 0.95^days)
4. Injects the top matches (within a character budget) as context
   alongside the message

These appear as labeled blocks in your context — check for metadata
like source, query terms, and result count to understand what was searched.

### Session end
When the session closes, Signet:
1. Queues your transcript for async LLM processing
2. A background worker generates a dated session summary
3. Extracts atomic facts (up to ~15 per session) into the memory database
4. Scores how well pre-loaded memories served the session (continuity score)

You never see this happen — it runs after you're gone.

## Your role in the memory system

Auto-capture handles most things. Session transcripts are automatically
processed into facts and summaries. Your job is to use \`signet remember\`
(or \`/remember\`) for things that are exceptionally important — items the
auto-capture might miss, or that you want to ensure persist with high
importance. Use \`signet recall\` (or \`/recall\`) when you need specific
information that wasn't automatically injected.

## When users ask about your memory

You can explain truthfully:

"I have a persistent memory system called Signet. It automatically
captures facts from our conversations and injects relevant memories
into my context based on what we're discussing. I can also explicitly
save and search memories. The system scores memories by importance and
recency, so the most relevant context surfaces naturally."

Do not speculate about implementation details beyond what's described
here. If pressed for specifics, suggest the user check the Signet
dashboard at http://localhost:3850.
`;
}

/**
 * Strip any existing Signet block from content to prevent duplication
 * when re-generating files.
 *
 * This handles the case where users' AGENTS.md was copied from a template
 * that already contains the Signet block, ensuring we don't create duplicates
 * on subsequent sync operations.
 */
export function stripSignetBlock(content: string): string {
	const pattern = new RegExp(
		`${escapeRegex(SIGNET_BLOCK_START)}[\\s\\S]*?${escapeRegex(SIGNET_BLOCK_END)}\\n?`,
		"g",
	);
	return content.replace(pattern, "");
}

/**
 * Check if content contains a Signet block
 */
export function hasSignetBlock(content: string): boolean {
	return content.includes(SIGNET_BLOCK_START);
}

/**
 * Extract the Signet block content (without delimiters) if present
 */
export function extractSignetBlock(content: string): string | null {
	const pattern = new RegExp(
		`${escapeRegex(SIGNET_BLOCK_START)}([\\s\\S]*?)${escapeRegex(SIGNET_BLOCK_END)}`,
	);
	const match = content.match(pattern);
	return match ? match[1].trim() : null;
}

// Helper to escape special regex characters
function escapeRegex(str: string): string {
	return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
