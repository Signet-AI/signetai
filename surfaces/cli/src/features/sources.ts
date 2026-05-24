import { addDiscordSource, addObsidianSource, loadSourcesConfig, removeSource } from "@signet/core";
import chalk from "chalk";

export interface SourcesDeps {
	readonly agentsDir: string;
	readonly removeSourceFromDaemon?: (sourceId: string) => Promise<DaemonRemoveSourceResult>;
}

export type DaemonRemoveSourceResult =
	| {
			readonly ok: true;
			readonly source?: { readonly name?: string; readonly root?: string };
			readonly purged?: number;
	  }
	| { readonly ok: false; readonly error: string };

export interface AddObsidianSourceOptions {
	readonly name?: string;
	readonly exclude?: readonly string[];
}

export interface AddDiscordSourceOptions {
	readonly guild?: readonly string[];
	readonly tokenRef?: string;
	readonly name?: string;
	readonly channel?: readonly string[];
	readonly maxMessages?: string;
	readonly since?: string;
	readonly threads?: boolean;
	readonly archivedThreads?: boolean;
	readonly includePrivateArchivedThreads?: boolean;
	readonly members?: boolean;
	readonly attachments?: boolean;
	readonly embeds?: boolean;
	readonly polls?: boolean;
	readonly threadMembers?: boolean;
	readonly mode?: "rest" | "gateway-tail" | "desktop-cache";
}

export async function addObsidianVaultSource(
	path: string,
	options: AddObsidianSourceOptions,
	deps: SourcesDeps,
): Promise<void> {
	const excludeGlobs = options.exclude && options.exclude.length > 0 ? options.exclude : undefined;
	const result = addObsidianSource({ root: path, name: options.name, excludeGlobs }, deps.agentsDir);
	if (result.ok === false) {
		console.error(chalk.red(`✗ ${result.error}`));
		process.exitCode = 1;
		return;
	}

	const verb = result.created ? "Added" : "Updated";
	console.log(chalk.green(`✓ ${verb} Obsidian source: ${result.source.name}`));
	console.log(chalk.dim(`  ${result.source.root}`));
	console.log();
	console.log(chalk.dim("The daemon indexes configured sources on startup and during its native-memory polling loop."));
	console.log(chalk.dim("Run `signet daemon restart` if the daemon is already running."));
}

export async function addDiscordSourceFromCli(options: AddDiscordSourceOptions, deps: SourcesDeps): Promise<void> {
	const guildIds = options.guild ?? [];
	const maxMessagesPerChannel =
		options.maxMessages === undefined ? undefined : Number.parseInt(options.maxMessages, 10);
	const result = addDiscordSource(
		{
			guildIds,
			tokenRef: options.tokenRef ?? "",
			name: options.name,
			channelFilter: options.channel,
			maxMessagesPerChannel,
			includeThreads: options.threads,
			includeArchivedThreads: options.archivedThreads,
			includePrivateArchivedThreads: options.includePrivateArchivedThreads,
			includeMembers: options.members,
			includeAttachments: options.attachments,
			includeEmbeds: options.embeds,
			includePolls: options.polls,
			includeThreadMembers: options.threadMembers,
			since: options.since,
			syncMode: options.mode,
		},
		deps.agentsDir,
	);
	if (result.ok === false) {
		console.error(chalk.red(`✗ ${result.error}`));
		process.exitCode = 1;
		return;
	}

	const verb = result.created ? "Added" : "Updated";
	console.log(chalk.green(`✓ ${verb} Discord source: ${result.source.name}`));
	console.log(chalk.dim(`  ${result.source.root}`));
	console.log(chalk.dim(`  tokenRef: ${result.source.providerSettings?.tokenRef ?? ""}`));
	console.log();
	console.log(chalk.dim("The daemon indexes Discord through the shared Sources job pipeline."));
	console.log(chalk.dim("Run `signet daemon restart` if the daemon is already running."));
}

export async function listSources(deps: SourcesDeps): Promise<void> {
	const config = loadSourcesConfig(deps.agentsDir);
	if (config.sources.length === 0) {
		console.log(chalk.dim("No external sources configured."));
		console.log(chalk.dim("Add an Obsidian vault with `signet sources add obsidian /path/to/vault`."));
		return;
	}

	for (const source of config.sources) {
		const status = source.enabled ? chalk.green("enabled") : chalk.dim("disabled");
		console.log(`${source.name} ${chalk.dim(`(${source.kind}, ${source.mode}, ${status})`)}`);
		console.log(chalk.dim(`  id: ${source.id}`));
		console.log(chalk.dim(`  root: ${source.root}`));
		if (source.kind === "discord" && source.providerSettings) {
			const guildIds = Array.isArray(source.providerSettings.guildIds)
				? source.providerSettings.guildIds.filter((entry) => typeof entry === "string")
				: [];
			if (guildIds.length > 0) console.log(chalk.dim(`  guilds: ${guildIds.join(", ")}`));
			if (typeof source.providerSettings.tokenRef === "string")
				console.log(chalk.dim(`  tokenRef: ${source.providerSettings.tokenRef}`));
		}
		if (source.excludeGlobs?.length) console.log(chalk.dim(`  excludes: ${source.excludeGlobs.join(", ")}`));
		if (source.lastIndexedAt) console.log(chalk.dim(`  last indexed: ${source.lastIndexedAt}`));
	}
}

export async function removeConfiguredSource(sourceId: string, deps: SourcesDeps): Promise<void> {
	if (deps.removeSourceFromDaemon) {
		const daemonResult = await deps.removeSourceFromDaemon(sourceId);
		if (daemonResult.ok === true) {
			const name = daemonResult.source?.name ?? sourceId;
			console.log(chalk.green(`✓ Removed source: ${name}`));
			if (daemonResult.source?.root) console.log(chalk.dim(`  ${daemonResult.source.root}`));
			console.log(chalk.dim(`  Purged ${daemonResult.purged ?? 0} Signet-owned source rows from the daemon database.`));
			console.log(chalk.dim("  Source files were not modified."));
			return;
		}
		console.warn(
			chalk.yellow(`! Daemon purge unavailable (${daemonResult.error}). Falling back to local config-only removal.`),
		);
	}

	const result = removeSource(sourceId, deps.agentsDir);
	if (result.ok === false) {
		console.error(chalk.red(`✗ ${result.error}`));
		process.exitCode = 1;
		return;
	}

	console.log(chalk.green(`✓ Removed source config: ${result.source.name}`));
	console.log(chalk.dim(`  ${result.source.root}`));
	console.log(chalk.dim("  Source files were not modified."));
	console.log(
		chalk.dim("  Indexed source rows/chunks/graph artifacts were not purged because the daemon API was unavailable."),
	);
	console.log(chalk.dim("  Start the daemon and run this command again if a database purge is still required."));
}
