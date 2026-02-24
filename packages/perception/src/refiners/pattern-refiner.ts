/**
 * Pattern Refiner — Daily Behavioral Pattern Detection Engine.
 *
 * Analyzes accumulated perception data (7–30 days) to detect recurring
 * temporal, tool-usage, productivity, collaboration, and project-cycling
 * patterns. Runs at most twice daily (12-hour cooldown).
 *
 * Detected patterns are stored as memories with type "pattern" and
 * tag "daily-pattern" for long-term agent context enrichment.
 */

import { BaseRefiner, sanitizeForPrompt, anonymizePath } from "./base";
import type { CaptureBundle, ExtractedMemory } from "../types";
import type { RefinerLLMConfig } from "./base";

const PATTERN_SYSTEM_PROMPT = `You are analyzing a user's work activity over MULTIPLE DAYS to detect recurring behavioral patterns.
You will receive aggregated data about their screen usage, terminal commands, file changes, git activity, and optionally voice activity.

Detect the following types of patterns:

1. TEMPORAL PATTERNS:
   - Consistent work start/end times
   - Regular breaks or lunch periods
   - Day-of-week variations (e.g., "deep work Tuesdays", "meeting Wednesdays")
   - Late night or weekend work tendencies

2. TOOL USAGE PATTERNS:
   - Which tools are used for which tasks (e.g., "VS Code for TypeScript, Vim for config")
   - Debugging tool preferences ("switches to terminal when debugging")
   - Habitual command sequences ("always runs tests before committing")

3. PRODUCTIVITY PATTERNS:
   - Peak focus periods (sustained single-app usage)
   - Context switch frequency at different times
   - Average deep work session length
   - Times when productivity drops (more switching, less output)

4. COLLABORATION PATTERNS:
   - Git commit frequency by day/time
   - Voice/meeting activity patterns
   - Code review vs coding time balance

5. PROJECT CYCLING PATTERNS:
   - How time is split across projects
   - Whether the user alternates between projects daily/weekly
   - Primary vs secondary project allocation

For each pattern, provide:
{
  "pattern": "clear, concise description of the pattern",
  "category": "TEMPORAL|TOOL_USAGE|PRODUCTIVITY|COLLABORATION|PROJECT_CYCLING",
  "evidence": "specific data points that support this pattern",
  "strength": "weak|moderate|strong",
  "confidence": 0.0-1.0,
  "actionable_insight": "how an AI agent could use this pattern to be more helpful"
}

Return a JSON array. Only report patterns with confidence >= 0.5 and at least moderate strength.
Be specific with times, numbers, and percentages where the data supports it.
If insufficient data to detect patterns, return [].`;

interface PatternExtraction {
	pattern: string;
	category: string;
	evidence: string;
	strength: string;
	confidence: number;
	actionable_insight?: string;
}

export class PatternRefiner extends BaseRefiner {
	readonly name = "pattern-detector";
	readonly cooldownMinutes = 720; // 12 hours — runs at most twice daily
	readonly systemPrompt = PATTERN_SYSTEM_PROMPT;

	constructor(llmConfig?: Partial<RefinerLLMConfig>) {
		super(llmConfig);
	}

	/**
	 * Pattern detection needs substantial data — at least multiple sessions
	 * worth of screen captures and/or terminal commands.
	 */
	hasEnoughData(bundle: CaptureBundle): boolean {
		// We need meaningful accumulation across time:
		// At least 20 screen captures OR 15 terminal commands OR 10 file activities
		const totalData =
			bundle.screen.length +
			bundle.terminal.length +
			bundle.files.length +
			bundle.comms.length +
			bundle.voice.length;

		return totalData >= 30;
	}

	formatContext(bundle: CaptureBundle): string {
		const sections: string[] = [];
		sections.push(`Analysis window: ${bundle.since} to ${bundle.until}`);
		sections.push("");

		// ----- Screen activity: aggregate by hour and by app -----
		if (bundle.screen.length > 0) {
			sections.push("## Screen Activity Summary");
			sections.push(`Total captures: ${bundle.screen.length}`);

			// App usage distribution
			const appCounts = new Map<string, number>();
			const hourCounts = new Array(24).fill(0);
			const dayOfWeekCounts = new Map<string, Map<string, number>>(); // day -> app -> count

			for (const sc of bundle.screen) {
				appCounts.set(
					sc.focusedApp,
					(appCounts.get(sc.focusedApp) || 0) + 1,
				);

				const ts = new Date(sc.timestamp);
				if (!isNaN(ts.getTime())) {
					hourCounts[ts.getHours()]++;

					const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][ts.getDay()];
					if (!dayOfWeekCounts.has(dayName)) {
						dayOfWeekCounts.set(dayName, new Map());
					}
					const dayMap = dayOfWeekCounts.get(dayName)!;
					dayMap.set(sc.focusedApp, (dayMap.get(sc.focusedApp) || 0) + 1);
				}
			}

			// Top apps
			const sortedApps = [...appCounts.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10);
			sections.push("\nApp Usage:");
			for (const [app, count] of sortedApps) {
				const pct = Math.round((count / bundle.screen.length) * 100);
				sections.push(`  ${app}: ${count} captures (${pct}%)`);
			}

			// Activity by hour
			sections.push("\nActivity by Hour:");
			for (let h = 0; h < 24; h++) {
				if (hourCounts[h] > 0) {
					sections.push(`  ${String(h).padStart(2, "0")}:00 — ${hourCounts[h]} captures`);
				}
			}

			// Activity by day of week
			if (dayOfWeekCounts.size > 0) {
				sections.push("\nActivity by Day of Week:");
				for (const [day, apps] of dayOfWeekCounts) {
					const total = [...apps.values()].reduce((a, b) => a + b, 0);
					const topApp = [...apps.entries()].sort((a, b) => b[1] - a[1])[0];
					sections.push(
						`  ${day}: ${total} captures (top: ${topApp?.[0] || "unknown"})`,
					);
				}
			}

			// Window title samples (for project detection)
			const uniqueWindows = new Set<string>();
			for (const sc of bundle.screen) {
				if (sc.focusedWindow) uniqueWindows.add(sc.focusedWindow);
			}
			if (uniqueWindows.size > 0) {
				sections.push("\nUnique Window Titles (sample):");
				sections.push("<user_data>");
				let wCount = 0;
				for (const w of uniqueWindows) {
					if (wCount >= 15) break;
					sections.push(`  • ${sanitizeForPrompt(w, 200)}`);
					wCount++;
				}
				sections.push("</user_data>");
			}

			sections.push("");
		}

		// ----- Terminal commands -----
		if (bundle.terminal.length > 0) {
			sections.push("## Terminal Activity");
			sections.push(`Total commands: ${bundle.terminal.length}`);

			// Group by working directory
			const byDir = new Map<string, string[]>();
			for (const tc of bundle.terminal) {
				const dir = tc.workingDirectory || "unknown";
				if (!byDir.has(dir)) byDir.set(dir, []);
				byDir.get(dir)!.push(tc.command);
			}

			for (const [dir, cmds] of byDir) {
				sections.push(`\nDirectory: ${dir}`);
				// Show unique commands with count
				const cmdCounts = new Map<string, number>();
				for (const cmd of cmds) {
					cmdCounts.set(cmd, (cmdCounts.get(cmd) || 0) + 1);
				}
				const sorted = [...cmdCounts.entries()]
					.sort((a, b) => b[1] - a[1])
					.slice(0, 15);
				for (const [cmd, count] of sorted) {
					sections.push(`  ${count > 1 ? `(×${count}) ` : ""}$ ${cmd}`);
				}
			}

			// Terminal usage by hour
			const termHourCounts = new Array(24).fill(0);
			for (const tc of bundle.terminal) {
				const ts = new Date(tc.timestamp);
				if (!isNaN(ts.getTime())) {
					termHourCounts[ts.getHours()]++;
				}
			}
			sections.push("\nTerminal Usage by Hour:");
			for (let h = 0; h < 24; h++) {
				if (termHourCounts[h] > 0) {
					sections.push(`  ${String(h).padStart(2, "0")}:00 — ${termHourCounts[h]} commands`);
				}
			}

			sections.push("");
		}

		// ----- File activity -----
		if (bundle.files.length > 0) {
			sections.push("## File Activity");
			sections.push(`Total events: ${bundle.files.length}`);

			// By file type
			const typeCounts = new Map<string, number>();
			for (const fa of bundle.files) {
				typeCounts.set(fa.fileType, (typeCounts.get(fa.fileType) || 0) + 1);
			}
			sections.push("\nFile types:");
			const sortedTypes = [...typeCounts.entries()]
				.sort((a, b) => b[1] - a[1])
				.slice(0, 10);
			for (const [type, count] of sortedTypes) {
				sections.push(`  .${type}: ${count} events`);
			}

			// By git branch (project indicator)
			const branchCounts = new Map<string, number>();
			for (const fa of bundle.files) {
				if (fa.gitBranch) {
					branchCounts.set(
						fa.gitBranch,
						(branchCounts.get(fa.gitBranch) || 0) + 1,
					);
				}
			}
			if (branchCounts.size > 0) {
				sections.push("\nGit branches:");
				for (const [branch, count] of branchCounts) {
					sections.push(`  ${branch}: ${count} events`);
				}
			}

			sections.push("");
		}

		// ----- Git commits -----
		if (bundle.comms.length > 0) {
			sections.push("## Git Commits");
			sections.push(`Total commits: ${bundle.comms.length}`);

			// Commits by day of week
			const commitsByDay = new Map<string, number>();
			const commitsByHour = new Array(24).fill(0);
			for (const cc of bundle.comms) {
				const ts = new Date(cc.timestamp);
				if (!isNaN(ts.getTime())) {
					const dayName = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][ts.getDay()];
					commitsByDay.set(dayName, (commitsByDay.get(dayName) || 0) + 1);
					commitsByHour[ts.getHours()]++;
				}
			}

			if (commitsByDay.size > 0) {
				sections.push("\nCommits by Day:");
				for (const [day, count] of commitsByDay) {
					sections.push(`  ${day}: ${count}`);
				}
			}

			sections.push("\nCommits by Hour:");
			for (let h = 0; h < 24; h++) {
				if (commitsByHour[h] > 0) {
					sections.push(`  ${String(h).padStart(2, "0")}:00 — ${commitsByHour[h]}`);
				}
			}

			// Commit messages (for project/task context)
			sections.push("\nRecent commit messages:");
			sections.push("<user_data>");
			for (const cc of bundle.comms.slice(-15)) {
				const repo = cc.metadata?.repo || "unknown";
				sections.push(`  [${repo}] ${sanitizeForPrompt(cc.content, 300)}`);
			}
			sections.push("</user_data>");

			sections.push("");
		}

		// ----- Voice activity -----
		if (bundle.voice.length > 0) {
			sections.push("## Voice Activity");
			sections.push(`Total segments: ${bundle.voice.length}`);

			const speakingSegments = bundle.voice.filter((v) => v.isSpeaking);
			sections.push(`Speaking segments: ${speakingSegments.length}`);

			// Voice activity by hour
			const voiceHourCounts = new Array(24).fill(0);
			for (const vs of bundle.voice) {
				const ts = new Date(vs.timestamp);
				if (!isNaN(ts.getTime())) {
					voiceHourCounts[ts.getHours()]++;
				}
			}
			sections.push("\nVoice Activity by Hour:");
			for (let h = 0; h < 24; h++) {
				if (voiceHourCounts[h] > 0) {
					sections.push(`  ${String(h).padStart(2, "0")}:00 — ${voiceHourCounts[h]} segments`);
				}
			}

			// Sample transcripts (redacted)
			if (speakingSegments.length > 0) {
				sections.push("\nSample transcripts:");
				sections.push("<user_data>");
				for (const vs of speakingSegments.slice(-5)) {
					sections.push(`  "${sanitizeForPrompt(vs.transcript, 100)}"`);
				}
				sections.push("</user_data>");
			}

			sections.push("");
		}

		return sections.join("\n");
	}

	parseResponse(response: string): ExtractedMemory[] {
		const parsed = this.parseJsonArray(response) as PatternExtraction[];
		const memories: ExtractedMemory[] = [];

		for (const item of parsed) {
			if (
				typeof item.pattern !== "string" ||
				typeof item.confidence !== "number" ||
				item.confidence < 0.5
			) {
				continue;
			}

			// Skip weak patterns
			if (item.strength === "weak") continue;

			// Map strength to importance
			const importanceMap: Record<string, number> = {
				moderate: 0.6,
				strong: 0.85,
			};

			const content = item.actionable_insight
				? `${item.pattern}. Insight: ${item.actionable_insight}`
				: item.pattern;

			memories.push({
				content,
				type: "pattern",
				importance: importanceMap[item.strength] ?? 0.6,
				confidence: item.confidence,
				tags: [
					"pattern",
					"daily-pattern",
					item.category?.toLowerCase().replace(/_/g, "-") || "behavioral",
				],
				sourceCaptures: [],
			});
		}

		return memories;
	}
}
