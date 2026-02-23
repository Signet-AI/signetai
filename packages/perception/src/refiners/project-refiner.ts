/**
 * Project Refiner — extracts active projects from screen content,
 * file paths, and git repository activity.
 */

import { BaseRefiner } from "./base";
import type { CaptureBundle, ExtractedMemory } from "../types";
import type { RefinerLLMConfig } from "./base";

const PROJECT_SYSTEM_PROMPT = `You are analyzing a user's work activity to identify ACTIVE PROJECTS they are working on.

Look at their screen content, file activity, terminal commands, and git commits to determine:
- Project names and descriptions
- Technologies/stack used
- Current focus area within each project
- Repository paths

For each project, provide:
{
  "name": "project name",
  "description": "what this project is about (brief)",
  "technologies": ["tech1", "tech2"],
  "repoPath": "/path/to/repo (if visible)",
  "currentFocus": "what they're currently working on in this project",
  "confidence": 0.0-1.0
}

Return a JSON array. Only report projects with confidence >= 0.5.
Prefer specific project names over generic descriptions.`;

interface ProjectExtraction {
	name: string;
	description: string;
	technologies: string[];
	repoPath?: string;
	currentFocus?: string;
	confidence: number;
}

export class ProjectRefiner extends BaseRefiner {
	readonly name = "project-extractor";
	readonly cooldownMinutes = 20;
	readonly systemPrompt = PROJECT_SYSTEM_PROMPT;

	constructor(llmConfig?: Partial<RefinerLLMConfig>) {
		super(llmConfig);
	}

	hasEnoughData(bundle: CaptureBundle): boolean {
		return (
			bundle.screen.length >= 3 ||
			bundle.files.length >= 5 ||
			bundle.comms.length >= 1
		);
	}

	formatContext(bundle: CaptureBundle): string {
		const sections: string[] = [];

		if (bundle.screen.length > 0) {
			sections.push("## Focused Windows");
			const seen = new Set<string>();
			for (const sc of bundle.screen) {
				const key = `${sc.focusedApp}: ${sc.focusedWindow}`;
				if (!seen.has(key)) {
					sections.push(`  ${key}`);
					seen.add(key);
				}
			}
			sections.push("");
		}

		if (bundle.files.length > 0) {
			sections.push("## Recent File Activity");
			// Extract unique directory roots
			const dirs = new Set<string>();
			for (const f of bundle.files) {
				const parts = f.filePath.split("/");
				// Get project-level directory (e.g., ~/projects/myproject)
				if (parts.length >= 4) {
					dirs.add(parts.slice(0, 4).join("/"));
				}
				sections.push(
					`  ${f.eventType}: ${f.filePath}${f.gitBranch ? ` [${f.gitBranch}]` : ""}`,
				);
			}
			sections.push("");
		}

		if (bundle.terminal.length > 0) {
			sections.push("## Terminal Commands");
			for (const tc of bundle.terminal.slice(-15)) {
				sections.push(`  ${tc.workingDirectory || ""}$ ${tc.command}`);
			}
			sections.push("");
		}

		if (bundle.comms.length > 0) {
			sections.push("## Git Commits");
			for (const cc of bundle.comms) {
				sections.push(
					`  [${cc.metadata.repo || ""}] ${cc.content} (${cc.metadata.branch || ""})`,
				);
			}
			sections.push("");
		}

		return sections.join("\n");
	}

	parseResponse(response: string): ExtractedMemory[] {
		const parsed = this.parseJsonArray(response) as ProjectExtraction[];
		const memories: ExtractedMemory[] = [];

		for (const item of parsed) {
			if (
				typeof item.name !== "string" ||
				typeof item.confidence !== "number" ||
				item.confidence < 0.5
			) {
				continue;
			}

			const techList =
				Array.isArray(item.technologies) && item.technologies.length > 0
					? ` using ${item.technologies.join(", ")}`
					: "";

			const focus = item.currentFocus
				? `. Currently working on: ${item.currentFocus}`
				: "";

			memories.push({
				content: `Active project: ${item.name} — ${item.description || "no description"}${techList}${focus}`,
				type: "fact",
				importance: 0.7,
				confidence: item.confidence,
				tags: [
					"project",
					item.name.toLowerCase(),
					...(item.technologies || []).map((t) => t.toLowerCase()),
				],
				sourceCaptures: [],
			});
		}

		return memories;
	}
}
