/**
 * Task preset templates for quick task creation.
 */

export interface TaskPreset {
	readonly label: string;
	readonly description: string;
	readonly name: string;
	readonly prompt: string;
	readonly harness: "claude-code" | "opencode" | "codex";
	readonly cronExpression: string;
	readonly skillName?: string;
	readonly skillMode?: "inject" | "slash";
}

export const TASK_PRESETS: readonly TaskPreset[] = [
	{
		label: "PR Review",
		description: "Review open pull requests daily",
		name: "Review open PRs",
		prompt:
			"Review all open pull requests. Summarize changes, flag potential issues, and note any that need urgent attention.",
		harness: "claude-code",
		cronExpression: "0 9 * * *",
	},
	{
		label: "Test Suite",
		description: "Run tests and report failures",
		name: "Run test suite",
		prompt: "Run the full test suite. Report any failures with context about what broke and likely causes.",
		harness: "claude-code",
		cronExpression: "0 * * * *",
	},
	{
		label: "Memory Maintenance",
		description: "Clean up and deduplicate memories",
		name: "Memory maintenance",
		prompt:
			"Review recent memories for duplicates, outdated information, and low-quality entries. Suggest cleanup actions.",
		harness: "claude-code",
		cronExpression: "0 9 * * 0",
		skillName: "memory-debug",
		skillMode: "inject",
	},
	{
		label: "Code Review",
		description: "Review recent commits for issues",
		name: "Review recent commits",
		prompt: "Review commits from the last 24 hours. Look for bugs, style issues, missing tests, and security concerns.",
		harness: "claude-code",
		cronExpression: "0 17 * * *",
	},
	{
		label: "Docs Audit",
		description: "Check documentation is up to date",
		name: "Documentation audit",
		prompt:
			"Audit the project documentation. Check for outdated references, missing docs for new features, and broken links.",
		harness: "claude-code",
		cronExpression: "0 9 * * 1",
	},
];
