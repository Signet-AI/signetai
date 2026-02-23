/**
 * Workflow Refiner — detects repeated procedural patterns
 * from terminal commands and app switching.
 */

import { BaseRefiner } from "./base";
import type { CaptureBundle, ExtractedMemory } from "../types";
import type { RefinerLLMConfig } from "./base";

const WORKFLOW_SYSTEM_PROMPT = `Analyze the user's terminal commands, app switching, and file activity for WORKFLOW PATTERNS.
Look for:
- Repeated command sequences (test → fix → test → commit)
- Debugging patterns (check logs → add print → run → check)
- Deployment patterns (build → test → deploy → verify)
- Research patterns (search → read → bookmark → try)
- Communication patterns (Slack → write response → back to code)

For each workflow:
{
  "workflow": "descriptive name",
  "steps": ["step 1", "step 2", "..."],
  "trigger": "what typically starts this workflow",
  "frequency": "how often this seems to happen",
  "tools_used": ["tool1", "tool2"],
  "confidence": 0.0-1.0
}

Return a JSON array.
Only report patterns seen 2+ times in the capture window. Confidence >= 0.6.`;

interface WorkflowExtraction {
	workflow: string;
	steps: string[];
	trigger?: string;
	frequency?: string;
	tools_used?: string[];
	confidence: number;
}

export class WorkflowRefiner extends BaseRefiner {
	readonly name = "workflow-extractor";
	readonly cooldownMinutes = 30;
	readonly systemPrompt = WORKFLOW_SYSTEM_PROMPT;

	constructor(llmConfig?: Partial<RefinerLLMConfig>) {
		super(llmConfig);
	}

	hasEnoughData(bundle: CaptureBundle): boolean {
		return bundle.terminal.length >= 5 || bundle.screen.length >= 10;
	}

	formatContext(bundle: CaptureBundle): string {
		const sections: string[] = [];

		if (bundle.terminal.length > 0) {
			sections.push("## Terminal Command Sequence (chronological)");
			for (const tc of bundle.terminal.slice(-40)) {
				const dir = tc.workingDirectory ? `[${tc.workingDirectory}] ` : "";
				sections.push(`  ${tc.timestamp} ${dir}$ ${tc.command}`);
			}
			sections.push("");
		}

		if (bundle.screen.length > 0) {
			sections.push("## App Switching Sequence");
			let prevApp = "";
			for (const sc of bundle.screen) {
				const app = `${sc.focusedApp}: ${sc.focusedWindow}`;
				if (app !== prevApp) {
					sections.push(`  ${sc.timestamp} → ${app}`);
					prevApp = app;
				}
			}
			sections.push("");
		}

		if (bundle.files.length > 0) {
			sections.push("## File Activity Sequence");
			for (const fa of bundle.files.slice(-30)) {
				sections.push(
					`  ${fa.timestamp} ${fa.eventType}: ${fa.filePath}`,
				);
			}
			sections.push("");
		}

		return sections.join("\n");
	}

	parseResponse(response: string): ExtractedMemory[] {
		const parsed = this.parseJsonArray(response) as WorkflowExtraction[];
		const memories: ExtractedMemory[] = [];

		for (const item of parsed) {
			if (
				typeof item.workflow !== "string" ||
				typeof item.confidence !== "number" ||
				item.confidence < 0.6
			) {
				continue;
			}

			const steps = Array.isArray(item.steps)
				? item.steps.join(" → ")
				: "unknown steps";

			const trigger = item.trigger
				? ` Triggered by: ${item.trigger}.`
				: "";

			const tools =
				Array.isArray(item.tools_used) && item.tools_used.length > 0
					? ` Tools: ${item.tools_used.join(", ")}.`
					: "";

			memories.push({
				content: `Workflow pattern "${item.workflow}": ${steps}.${trigger}${tools}`,
				type: "procedural",
				importance: 0.7,
				confidence: item.confidence,
				tags: [
					"workflow",
					"procedural",
					...(item.tools_used || []).map((t) => t.toLowerCase()),
				],
				sourceCaptures: [],
			});
		}

		return memories;
	}
}
