/**
 * Skill Refiner — THE KEY REFINER.
 *
 * Extracts demonstrated skills from screen content, terminal commands,
 * and file activity. Evidence-based with confidence scores and
 * proficiency levels.
 */

import { BaseRefiner } from "./base";
import type { CaptureBundle, ExtractedMemory } from "../types";
import type { RefinerLLMConfig } from "./base";

const SKILL_SYSTEM_PROMPT = `You are analyzing a user's work activity to identify demonstrated skills and expertise.
You see their screen content (OCR text from apps), terminal commands, and file activity.

Extract SKILLS — things the user knows how to do, demonstrated by their actual actions.
Be specific and evidence-based. Don't guess. Only extract what you can clearly see.

Categories:
- TECHNICAL: Programming languages, frameworks, tools, CLI commands
- DOMAIN: Business domains, industry knowledge, technical areas
- PROCESS: Development practices, debugging approaches, deployment patterns
- COMMUNICATION: Writing style, documentation habits, collaboration patterns
- TOOL_MASTERY: Specific tools used with apparent fluency (keyboard shortcuts, advanced features)

For each skill, provide:
{
  "skill": "descriptive name",
  "category": "TECHNICAL|DOMAIN|PROCESS|COMMUNICATION|TOOL_MASTERY",
  "evidence": "what in the captures demonstrates this",
  "proficiency": "learning|competent|proficient|expert",
  "confidence": 0.0-1.0
}

Return a JSON array. If insufficient evidence, return [].
Only report skills with confidence >= 0.6.`;

interface SkillExtraction {
	skill: string;
	category: string;
	evidence: string;
	proficiency: string;
	confidence: number;
}

export class SkillRefiner extends BaseRefiner {
	readonly name = "skill-extractor";
	readonly cooldownMinutes = 30;
	readonly systemPrompt = SKILL_SYSTEM_PROMPT;

	constructor(llmConfig?: Partial<RefinerLLMConfig>) {
		super(llmConfig);
	}

	hasEnoughData(bundle: CaptureBundle): boolean {
		return bundle.screen.length >= 5 || bundle.terminal.length >= 3;
	}

	formatContext(bundle: CaptureBundle): string {
		const sections: string[] = [];

		// Screen captures — deduplicate by window, show top entries
		if (bundle.screen.length > 0) {
			const uniqueWindows = new Map<string, string>();
			for (const sc of bundle.screen) {
				const key = `${sc.focusedApp}|${sc.focusedWindow}`;
				if (!uniqueWindows.has(key) || sc.ocrText.length > (uniqueWindows.get(key)?.length ?? 0)) {
					uniqueWindows.set(key, sc.ocrText);
				}
			}

			sections.push("## Screen Activity (focused windows)");
			let count = 0;
			for (const [key, text] of uniqueWindows) {
				if (count >= 10) break;
				const [app, window] = key.split("|");
				sections.push(`App: ${app} | Window: ${window}`);
				if (text) {
					sections.push(`Content: ${text.slice(0, 500)}`);
				}
				sections.push("");
				count++;
			}
		}

		// Terminal commands — group by working directory
		if (bundle.terminal.length > 0) {
			sections.push("## Terminal Commands");
			const byDir = new Map<string, string[]>();
			for (const tc of bundle.terminal) {
				const dir = tc.workingDirectory || "unknown";
				if (!byDir.has(dir)) byDir.set(dir, []);
				byDir.get(dir)!.push(tc.command);
			}
			for (const [dir, cmds] of byDir) {
				sections.push(`Directory: ${dir}`);
				for (const cmd of cmds.slice(-20)) {
					sections.push(`  $ ${cmd}`);
				}
				sections.push("");
			}
		}

		// File changes — group by project
		if (bundle.files.length > 0) {
			sections.push("## File Activity");
			for (const fa of bundle.files.slice(-30)) {
				const branch = fa.gitBranch ? ` (${fa.gitBranch})` : "";
				sections.push(
					`  ${fa.eventType}: ${fa.filePath} [${fa.fileType}]${branch}`,
				);
			}
			sections.push("");
		}

		// Git commits
		if (bundle.comms.length > 0) {
			sections.push("## Recent Git Commits");
			for (const cc of bundle.comms) {
				const repo = cc.metadata.repo || "";
				sections.push(`  [${repo}] ${cc.content} (by ${cc.metadata.author || "unknown"})`);
			}
			sections.push("");
		}

		return sections.join("\n");
	}

	parseResponse(response: string): ExtractedMemory[] {
		const parsed = this.parseJsonArray(response) as SkillExtraction[];
		const memories: ExtractedMemory[] = [];

		for (const item of parsed) {
			if (
				typeof item.skill !== "string" ||
				typeof item.confidence !== "number" ||
				item.confidence < 0.6
			) {
				continue;
			}

			// Map proficiency to importance
			const importanceMap: Record<string, number> = {
				learning: 0.4,
				competent: 0.6,
				proficient: 0.8,
				expert: 0.95,
			};

			memories.push({
				content: `User demonstrates ${item.proficiency || "competent"} skill in ${item.skill}: ${item.evidence || "observed through activity"}`,
				type: "skill",
				importance: importanceMap[item.proficiency] ?? 0.6,
				confidence: item.confidence,
				tags: [
					"skill",
					item.category?.toLowerCase() || "technical",
					item.skill.toLowerCase(),
					item.proficiency || "competent",
				],
				sourceCaptures: [],
			});
		}

		return memories;
	}
}
