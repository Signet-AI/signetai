import type { Command } from "commander";
import {
	type SourcesDeps,
	addDiscordSourceFromCli,
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
		.description("Index Discord guilds as read-only recall sources using a bot token secret reference")
		.requiredOption("--guild <id>", "Discord guild ID (repeatable)", collect, [])
		.requiredOption("--token-ref <secret>", "Signet secret name or external secret reference for the Discord bot token")
		.option("--name <name>", "Display name for the Discord source")
		.option("--channel <id-or-name>", "Channel ID or name filter (repeatable)", collect, [])
		.option("--max-messages <count>", "Maximum messages per channel per sync")
		.option("--since <iso-date>", "Lower bound for message history")
		.option("--no-threads", "Skip active and archived threads")
		.option("--no-archived-threads", "Skip archived thread discovery")
		.option("--include-private-archived-threads", "Include private archived thread discovery")
		.option("--no-members", "Skip guild member snapshots")
		.option("--no-attachments", "Skip attachment metadata artifacts")
		.option("--no-embeds", "Skip embed metadata artifacts")
		.option("--no-polls", "Skip poll metadata artifacts")
		.option("--no-thread-members", "Skip thread member snapshots")
		.option("--mode <mode>", "Sync mode: rest, gateway-tail, or desktop-cache", "rest")
		.action((options) => addDiscordSourceFromCli(options, deps));
}
