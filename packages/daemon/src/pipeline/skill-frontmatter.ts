/**
 * YAML round-trip frontmatter read/write for SKILL.md files.
 *
 * Uses the `yaml` package's Document API to preserve comments,
 * formatting, and existing fields when rewriting enrichment data
 * back into SKILL.md frontmatter.
 */

import { parseDocument, stringify } from "yaml";
import type { SkillFrontmatter } from "./skill-graph";

// ---------------------------------------------------------------------------
// Parse
// ---------------------------------------------------------------------------

const FRONTMATTER_RE = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/;

export interface ParsedSkillFile {
	readonly frontmatter: SkillFrontmatter;
	readonly body: string;
	readonly rawFrontmatter: string;
}

export function parseSkillFile(content: string): ParsedSkillFile | null {
	const match = content.match(FRONTMATTER_RE);
	if (!match) return null;

	const rawFm = match[1];
	const body = match[2];

	const doc = parseDocument(rawFm);
	const data = doc.toJSON() as Record<string, unknown> | null;
	if (!data) return null;

	const getString = (key: string): string =>
		typeof data[key] === "string" ? (data[key] as string) : "";

	const getStringArray = (key: string): string[] => {
		const val = data[key];
		if (Array.isArray(val)) return val.filter((v): v is string => typeof v === "string");
		if (typeof val === "string") {
			return val.split(",").map((s) => s.trim()).filter(Boolean);
		}
		return [];
	};

	return {
		frontmatter: {
			name: getString("name") || getString("title") || "",
			description: getString("description"),
			version: getString("version") || undefined,
			author: getString("author") || undefined,
			license: getString("license") || undefined,
			triggers: getStringArray("triggers").length > 0
				? getStringArray("triggers")
				: undefined,
			tags: getStringArray("tags").length > 0
				? getStringArray("tags")
				: undefined,
			permissions: getStringArray("permissions").length > 0
				? getStringArray("permissions")
				: undefined,
			role: getString("role") || undefined,
		},
		body,
		rawFrontmatter: rawFm,
	};
}

// ---------------------------------------------------------------------------
// Rewrite (round-trip preserving)
// ---------------------------------------------------------------------------

export interface FrontmatterPatch {
	readonly description?: string;
	readonly triggers?: readonly string[];
	readonly tags?: readonly string[];
}

/**
 * Apply enrichment data to a SKILL.md file's frontmatter using
 * YAML round-trip parsing. Preserves existing fields and comments.
 *
 * Returns the full rewritten file content, or null if parsing fails.
 */
export function patchSkillFrontmatter(
	fileContent: string,
	patch: FrontmatterPatch,
): string | null {
	const match = fileContent.match(FRONTMATTER_RE);
	if (!match) return null;

	const rawFm = match[1];
	const body = match[2];

	const doc = parseDocument(rawFm);

	if (patch.description) {
		doc.set("description", patch.description);
	}
	if (patch.triggers && patch.triggers.length > 0) {
		doc.set("triggers", [...patch.triggers]);
	}
	if (patch.tags && patch.tags.length > 0) {
		doc.set("tags", [...patch.tags]);
	}

	const newFm = doc.toString().trimEnd();
	return `---\n${newFm}\n---\n${body}`;
}
