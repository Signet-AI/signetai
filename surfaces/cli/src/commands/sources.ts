import type { Command } from "commander";
import {
	type SourcesDeps,
	addDiscordServerSource,
	addObsidianVaultSource,
	listSources,
	removeConfiguredSource,
} from "../features/sources.js";
import type { DaemonApiCall } from "../lib/daemon.js";

export interface RegisterSourcesCommandsDeps extends SourcesDeps {
	readonly secretApiCall?: DaemonApiCall;
}

function collect(value: string, previous: string[]): string[] {
	return [...previous, value];
}

export function registerSourcesCommands(program: Command, deps: RegisterSourcesCommandsDeps): void {
	const sources = program.command("sources").description("Manage external read-only knowledge sources");

	sources
		.command("list")
		.description("List configured external sources")
		.action(() => listSources(deps));

	sources
		.command("remove <sourceId>")
		.alias("disconnect")
		.description("Disconnect and purge a source from Signet")
		.action((sourceId: string) =>
			removeConfiguredSource(sourceId, {
				...deps,
				removeSourceFromDaemon: deps.secretApiCall
					? async (id) => {
							const result = await deps.secretApiCall?.(
								"DELETE",
								`/api/sources/${encodeURIComponent(id)}`,
								undefined,
								30_000,
							);
							if (!result?.ok) {
								const error =
									typeof result?.data === "object" && result.data !== null && "error" in result.data
										? String((result.data as { error?: unknown }).error)
										: "daemon request failed";
								return { ok: false, error };
							}
							const data = result.data as { source?: { name?: string; root?: string }; purged?: number };
							return { ok: true, source: data.source, purged: data.purged };
						}
					: undefined,
			}),
		);

	const add = sources.command("add").description("Add an external read-only knowledge source");

	add
		.command("obsidian <path>")
		.description("Index an Obsidian vault as a read-only recall source")
		.option("--name <name>", "Display name for the vault")
		.option(
			"--exclude <glob>",
			"Exclude glob (repeatable). Defaults already ignore dot-folders and Obsidian internals.",
			collect,
			[],
		)
		.action((path: string, options: { name?: string; exclude?: string[] }) =>
			addObsidianVaultSource(path, options, deps),
		);

	add
		.command("discord")
		.description("Index Discord server(s) as a read-only recall source")
		.requiredOption("--guild-id <id>", "Discord guild ID (repeatable)", collect, [])
		.requiredOption("--token-ref <ref>", "Signet secret reference for Discord bot token")
		.option("--name <name>", "Display name for the Discord source")
		.option("--channel-filter <channel>", "Channel name or ID to include (repeatable)", collect, [])
		.option("--max-messages <n>", "Max messages per channel", Number, 1000)
		.option("--no-threads", "Skip indexing threads")
		.option("--since <date>", "Only index messages after this ISO date")
		.action(
			(options: {
				guildId: string[];
				tokenRef: string;
				name?: string;
				channelFilter: string[];
				maxMessages: number;
				threads: boolean;
				since?: string;
			}) =>
				addDiscordServerSource(
					{
						guildIds: options.guildId,
						tokenRef: options.tokenRef,
						name: options.name,
						channelFilter: options.channelFilter.length > 0 ? options.channelFilter : undefined,
						maxMessagesPerChannel: options.maxMessages,
						includeThreads: options.threads,
						since: options.since,
					},
					deps,
				),
		);
}
