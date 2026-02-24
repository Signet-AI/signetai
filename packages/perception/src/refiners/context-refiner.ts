/**
 * Context Refiner — generates a rolling "current context" summary
 * for agent injection. This enables proactive assistance.
 */

import { BaseRefiner, sanitizeForPrompt, anonymizePath } from "./base";
import type { CaptureBundle, ExtractedMemory } from "../types";
import type { RefinerLLMConfig } from "./base";

const CONTEXT_SYSTEM_PROMPT = `Summarize what the user is CURRENTLY working on based on their recent activity.
This will be injected into their AI agent's context so the agent can be helpful.

Create a brief, actionable summary as JSON:
{
  "current_project": "project name",
  "current_task": "what they seem to be doing right now",
  "recent_context": "key things they've been looking at/working on",
  "potential_needs": ["things the agent could help with based on context"],
  "mood_signals": "focused|struggling|exploring|reviewing"
}

Be concise. Focus on actionable context that helps an agent be useful.
Return a single JSON object.`;

interface ContextExtraction {
	current_project?: string;
	current_task?: string;
	recent_context?: string;
	potential_needs?: string[];
	mood_signals?: string;
}

export class ContextRefiner extends BaseRefiner {
	readonly name = "context-extractor";
	readonly cooldownMinutes = 10; // More frequent — context changes fast
	readonly systemPrompt = CONTEXT_SYSTEM_PROMPT;

	constructor(llmConfig?: Partial<RefinerLLMConfig>) {
		super(llmConfig);
	}

	hasEnoughData(bundle: CaptureBundle): boolean {
		return (
			bundle.screen.length >= 2 ||
			bundle.terminal.length >= 2 ||
			bundle.files.length >= 3
		);
	}

	formatContext(bundle: CaptureBundle): string {
		const sections: string[] = [];

		if (bundle.screen.length > 0) {
			sections.push("## Current Screen (most recent first)");
			sections.push("<user_data>");
			// Show the last few captures
			const recent = bundle.screen.slice(-5);
			for (const sc of recent.reverse()) {
				sections.push(`  ${sc.focusedApp}: ${sc.focusedWindow}`);
				if (sc.ocrText) {
					sections.push(`  Content preview: ${sanitizeForPrompt(sc.ocrText, 200)}`);
				}
			}
			sections.push("</user_data>");
			sections.push("");
		}

		if (bundle.terminal.length > 0) {
			sections.push("## Recent Commands");
			sections.push("<user_data>");
			for (const tc of bundle.terminal.slice(-10)) {
				sections.push(`  $ ${sanitizeForPrompt(tc.command, 500)}`);
			}
			sections.push("</user_data>");
			sections.push("");
		}

		if (bundle.files.length > 0) {
			sections.push("## Recent File Changes");
			sections.push("<user_data>");
			for (const fa of bundle.files.slice(-10)) {
				sections.push(`  ${fa.eventType}: ${anonymizePath(fa.filePath)}`);
			}
			sections.push("</user_data>");
			sections.push("");
		}

		return sections.join("\n");
	}

	parseResponse(response: string): ExtractedMemory[] {
		const parsed = this.parseJsonObject(response) as ContextExtraction;
		const memories: ExtractedMemory[] = [];

		if (!parsed.current_project && !parsed.current_task) {
			return memories;
		}

		const parts: string[] = [];
		if (parsed.current_project) {
			parts.push(`Project: ${parsed.current_project}`);
		}
		if (parsed.current_task) {
			parts.push(`Task: ${parsed.current_task}`);
		}
		if (parsed.recent_context) {
			parts.push(`Context: ${parsed.recent_context}`);
		}
		if (parsed.mood_signals) {
			parts.push(`Status: ${parsed.mood_signals}`);
		}

		memories.push({
			content: `Current context: ${parts.join(". ")}`,
			type: "semantic",
			importance: 0.5, // Context is transient, lower importance
			confidence: 0.8,
			tags: [
				"context",
				"current",
				...(parsed.current_project
					? [parsed.current_project.toLowerCase()]
					: []),
			],
			sourceCaptures: [],
		});

		return memories;
	}
}
