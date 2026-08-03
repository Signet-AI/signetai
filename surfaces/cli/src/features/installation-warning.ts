import { homedir } from "node:os";
import { type SignetInstallationReport, inactivePackageManagerInstallations } from "@signet/core";
import chalk from "chalk";

function displayPath(path: string, home: string): string {
	if (path === home) return "~";
	if (path.startsWith(`${home}/`)) return `~${path.slice(home.length)}`;
	return path;
}

export function concurrentInstallationWarningLines(
	report: SignetInstallationReport,
	home: string = homedir(),
): readonly string[] {
	if (report.target.kind !== "native") return [];
	const duplicates = inactivePackageManagerInstallations(report);
	if (duplicates.length === 0) return [];

	const lines = [
		"Warning: another Signet installation was detected.",
		"",
		`Active:   ${displayPath(report.target.executablePath, home)} (native)`,
	];
	for (const duplicate of duplicates) {
		lines.push(`Inactive: ${displayPath(duplicate.executablePath, home)} (${duplicate.method})`);
	}
	lines.push(
		"",
		"After verifying the active installation, remove only the duplicate launcher (this keeps signet-mcp available):",
	);
	for (const command of new Set(
		duplicates.flatMap((duplicate) => (duplicate.removalCommand ? [duplicate.removalCommand] : [])),
	)) {
		lines.push(command);
	}
	return lines;
}

export function printConcurrentInstallationWarning(report: SignetInstallationReport): void {
	const lines = concurrentInstallationWarningLines(report);
	if (lines.length === 0) return;
	console.log();
	for (const [index, line] of lines.entries()) {
		console.log(index === 0 ? chalk.yellow(line) : line);
	}
}
