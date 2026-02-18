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

API keys and tokens are stored securely in Signet:

\`\`\`bash
signet secret get OPENAI_API_KEY
signet secret list
\`\`\`
${SIGNET_BLOCK_END}

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
