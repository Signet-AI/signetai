/**
 * Skill resolver for scheduled tasks.
 *
 * Reads a skill's SKILL.md content and integrates it into the task prompt
 * based on the configured mode (inject or slash).
 */

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { logger } from "../logger";

const AGENTS_DIR = process.env.SIGNET_PATH ?? join(homedir(), ".agents");

/**
 * Strip YAML frontmatter (everything between leading `---` delimiters).
 */
function stripFrontmatter(content: string): string {
	if (!content.startsWith("---")) return content;
	const end = content.indexOf("\n---", 3);
	if (end === -1) return content;
	return content.slice(end + 4).trimStart();
}

/**
 * Resolve skill content into the base prompt.
 *
 * - If `skillName` is null, returns `basePrompt` unchanged.
 * - **inject** mode: prepends skill content before the prompt.
 * - **slash** mode: wraps prompt with `/{skillName} {basePrompt}`.
 */
export function resolveSkillPrompt(
	basePrompt: string,
	skillName: string | null,
	skillMode: string | null,
): string {
	if (!skillName) return basePrompt;

	if (skillMode === "slash") {
		return `/${skillName} ${basePrompt}`;
	}

	// Default to inject mode
	const skillPath = join(AGENTS_DIR, "skills", skillName, "SKILL.md");
	try {
		const raw = readFileSync(skillPath, "utf-8");
		const content = stripFrontmatter(raw);
		return `${content}\n\n---\n\n${basePrompt}`;
	} catch {
		logger.warn("scheduler", `Skill file not found: ${skillPath}`, {
			skillName,
		});
		return basePrompt;
	}
}
