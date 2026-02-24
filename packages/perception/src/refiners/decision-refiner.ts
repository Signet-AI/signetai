/**
 * Decision Refiner — catches decisions from config changes,
 * commit messages, terminal commands, and voice transcripts.
 */

import { BaseRefiner, sanitizeForPrompt, anonymizePath } from "./base";
import type { CaptureBundle, ExtractedMemory } from "../types";
import type { RefinerLLMConfig } from "./base";

const DECISION_SYSTEM_PROMPT = `Analyze the user's recent activity for DECISIONS being made.
Look for:
- Configuration changes (choosing one option over another)
- Architecture decisions (file structure, dependency choices)
- Tool selections (using tool X instead of Y)
- Spoken decisions (voice transcripts containing "let's go with", "I'll use", "decided to")
- Written decisions (commit messages, comments with rationale)

For each decision:
{
  "decision": "what was decided",
  "reasoning": "visible evidence of why (if available)",
  "alternatives": ["other options that were visible/discussed"],
  "context": "what triggered this decision",
  "confidence": 0.0-1.0
}

Return a JSON array. Only report decisions with clear evidence. Confidence >= 0.5.`;

interface DecisionExtraction {
	decision: string;
	reasoning?: string;
	alternatives?: string[];
	context?: string;
	confidence: number;
}

export class DecisionRefiner extends BaseRefiner {
	readonly name = "decision-extractor";
	readonly cooldownMinutes = 20;
	readonly systemPrompt = DECISION_SYSTEM_PROMPT;

	constructor(llmConfig?: Partial<RefinerLLMConfig>) {
		super(llmConfig);
	}

	hasEnoughData(bundle: CaptureBundle): boolean {
		return (
			bundle.comms.length >= 1 ||
			bundle.terminal.length >= 3 ||
			bundle.screen.length >= 3 ||
			bundle.voice.length >= 1
		);
	}

	formatContext(bundle: CaptureBundle): string {
		const sections: string[] = [];

		if (bundle.comms.length > 0) {
			sections.push("## Git Commits (potential decisions)");
			sections.push("<user_data>");
			for (const cc of bundle.comms) {
				sections.push(
					`  [${cc.metadata.repo || ""}] ${sanitizeForPrompt(cc.content, 300)}`,
				);
			}
			sections.push("</user_data>");
			sections.push("");
		}

		if (bundle.terminal.length > 0) {
			sections.push("## Terminal Commands");
			sections.push("<user_data>");
			for (const tc of bundle.terminal.slice(-20)) {
				sections.push(`  $ ${sanitizeForPrompt(tc.command, 500)}`);
			}
			sections.push("</user_data>");
			sections.push("");
		}

		if (bundle.screen.length > 0) {
			sections.push("## Screen Content (config/settings screens)");
			sections.push("<user_data>");
			for (const sc of bundle.screen.slice(-5)) {
				if (sc.ocrText) {
					sections.push(`  [${sc.focusedApp}] ${sanitizeForPrompt(sc.ocrText, 300)}`);
				}
			}
			sections.push("</user_data>");
			sections.push("");
		}

		if (bundle.voice.length > 0) {
			sections.push("## Voice Transcripts");
			sections.push("<user_data>");
			for (const vs of bundle.voice) {
				if (vs.transcript) {
					sections.push(`  "${sanitizeForPrompt(vs.transcript, 500)}"`);
				}
			}
			sections.push("</user_data>");
			sections.push("");
		}

		if (bundle.files.length > 0) {
			// Focus on config file changes
			const configFiles = bundle.files.filter(
				(f) =>
					f.fileType === "json" ||
					f.fileType === "yaml" ||
					f.fileType === "yml" ||
					f.fileType === "toml" ||
					f.fileType === "env" ||
					f.filePath.includes("config"),
			);
			if (configFiles.length > 0) {
				sections.push("## Config File Changes");
				sections.push("<user_data>");
				for (const f of configFiles) {
					sections.push(`  ${f.eventType}: ${anonymizePath(f.filePath)}`);
				}
				sections.push("</user_data>");
				sections.push("");
			}
		}

		return sections.join("\n");
	}

	parseResponse(response: string): ExtractedMemory[] {
		const parsed = this.parseJsonArray(response) as DecisionExtraction[];
		const memories: ExtractedMemory[] = [];

		for (const item of parsed) {
			if (
				typeof item.decision !== "string" ||
				typeof item.confidence !== "number" ||
				item.confidence < 0.5
			) {
				continue;
			}

			const reasoning = item.reasoning
				? ` Reasoning: ${item.reasoning}`
				: "";
			const alternatives =
				Array.isArray(item.alternatives) && item.alternatives.length > 0
					? ` Alternatives considered: ${item.alternatives.join(", ")}`
					: "";

			memories.push({
				content: `Decision: ${item.decision}.${reasoning}${alternatives}`,
				type: "decision",
				importance: 0.75,
				confidence: item.confidence,
				tags: ["decision", "ambient-perception"],
				sourceCaptures: [],
			});
		}

		return memories;
	}
}
