import { SIGNET_SOURCE_CHECKOUT_DIRNAME } from "./workspace-source-repo";

export const SIGNET_GIT_PROTECTED_PATHS = [
	"memory/memories.db",
	"memory/memories.db-wal",
	"memory/memories.db-shm",
	"memory/memories.db-journal",
	`${SIGNET_SOURCE_CHECKOUT_DIRNAME}/`,
] as const;

export function mergeSignetGitignoreEntries(existingContent: string): string {
	const normalized = existingContent.replaceAll("\r\n", "\n");
	const lines = normalized.length > 0 ? normalized.split("\n") : [];
	if (lines.length > 0 && lines[lines.length - 1] === "") {
		lines.pop();
	}

	const existingEntries = new Set(lines.filter((line) => line.trim().length > 0));
	const missingEntries = SIGNET_GIT_PROTECTED_PATHS.filter((entry) => !existingEntries.has(entry));
	if (missingEntries.length === 0) {
		return existingContent;
	}

	const nextLines = [...lines];
	if (nextLines.length > 0) {
		nextLines.push("");
	}
	nextLines.push("# Signet generated data");
	nextLines.push(...missingEntries);
	return `${nextLines.join("\n")}\n`;
}
