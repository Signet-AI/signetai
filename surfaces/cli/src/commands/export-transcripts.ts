import { createWriteStream } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import chalk from "chalk";
import type { Command } from "commander";
import type { DaemonStreamResult } from "../lib/daemon";
export { parseTranscriptMessages } from "@signet/core";
export interface ExportTranscriptsDeps {
	readonly AGENTS_DIR: string;
	readonly fetchDaemonStream?: (
		path: string,
		options?: RequestInit & { timeout?: number },
	) => Promise<DaemonStreamResult>;
}
function collectOption(value: string, previous: string[] = []): string[] {
	return [...previous, value];
}

export function registerExportTranscriptsCommand(exportCmd: Command, deps: ExportTranscriptsDeps): void {
	exportCmd
		.command("transcripts")
		.description("Export session transcripts as JSONL (one conversation per line) for training/fine-tuning")
		.option("-o, --output <path>", "Write to a file instead of stdout")
		.option("--harness <name>", "Filter by harness (repeatable)", collectOption, [])
		.option("--agent <name>", "Filter by agent ID (repeatable)", collectOption, [])
		.option("--since <iso>", "Only transcripts created at or after this ISO timestamp")
		.option("--until <iso>", "Only transcripts created at or before this ISO timestamp")
		.option("--limit <n>", "Max conversations to export", Number.parseInt)
		.option("--offset <n>", "Skip N conversations (for resumable export)", Number.parseInt, 0)
		.option("--messages-only", "Skip system and tool messages in each conversation")
		.option("--json", "Output a JSON array instead of JSONL")
		.action(
			async (options: {
				output?: string;
				harness: string[];
				agent: string[];
				since?: string;
				until?: string;
				limit?: number;
				offset?: number;
				messagesOnly?: boolean;
				json?: boolean;
			}) => {
				if (options.limit !== undefined && (!Number.isInteger(options.limit) || options.limit < 0)) {
					console.error(chalk.red("  Error: --limit must be a non-negative integer"));
					process.exit(1);
				}
				if (options.offset !== undefined && (!Number.isInteger(options.offset) || options.offset < 0)) {
					console.error(chalk.red("  Error: --offset must be a non-negative integer"));
					process.exit(1);
				}

				if (!deps.fetchDaemonStream) throw new Error("Transcript export requires the daemon client");
				const query = new URLSearchParams();
				for (const harness of options.harness) query.append("harness", harness);
				for (const agent of options.agent) query.append("agentId", agent);
				for (const [key, value] of Object.entries({
					since: options.since,
					until: options.until,
					limit: options.limit,
					offset: options.offset,
					messagesOnly: options.messagesOnly,
					json: options.json,
				}))
					if (value !== undefined) query.set(key, String(value));
				const result = await deps.fetchDaemonStream(`/api/sources/imports/export/transcripts?${query}`, {
					timeout: 15 * 60_000,
				});
				if (!result.ok) throw new Error(result.error ?? `Transcript export failed: ${result.reason}`);
				if (!result.response.body) throw new Error("Empty export response");
				const output = options.output ? createWriteStream(options.output, { flags: "wx" }) : process.stdout;
				await pipeline(Readable.fromWeb(result.response.body), output, { end: Boolean(options.output) });
			},
		);
}
