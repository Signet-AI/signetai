import { readFileSync, writeFileSync } from "node:fs";
import {
	type AddDiscordSourceInput,
	type AddGitHubSourceInput,
	type SignetSourceEntry,
	addDiscordSource,
	addGitHubSource,
	addObsidianSource,
	loadSourcesConfig,
	removeSource,
} from "@signet/core";
import chalk from "chalk";

export interface SourcesDeps {
	readonly agentsDir: string;
	readonly addDiscordSourceToDaemon?: (input: AddDiscordSourceInput) => Promise<DaemonAddSourceResult>;
	readonly addGitHubSourceToDaemon?: (input: AddGitHubSourceInput) => Promise<DaemonAddSourceResult>;
	readonly removeSourceFromDaemon?: (sourceId: string) => Promise<DaemonRemoveSourceResult>;
	readonly exportSourceSnapshotFromDaemon?: (
		sourceId: string,
		options: { readonly includeLocalDiscord?: boolean },
	) => Promise<DaemonSourceSnapshotResult>;
	readonly importSourceSnapshotToDaemon?: (
		sourceId: string,
		snapshot: unknown,
		options: { readonly includeLocalDiscord?: boolean },
	) => Promise<DaemonImportSourceSnapshotResult>;
}

export type DaemonAddSourceResult =
	| {
			readonly ok: true;
			readonly source: SignetSourceEntry;
			readonly created: boolean;
			readonly queued?: boolean;
			readonly job?: unknown;
	  }
	| { readonly ok: false; readonly error: string; readonly fallbackToLocal?: boolean };

export type DaemonRemoveSourceResult =
	| {
			readonly ok: true;
			readonly source?: { readonly name?: string; readonly root?: string };
			readonly purged?: number;
	  }
	| { readonly ok: false; readonly error: string };

export type DaemonSourceSnapshotResult =
	| {
			readonly ok: true;
			readonly snapshot: unknown;
			readonly artifactCount?: number;
			readonly skippedLocalDiscordArtifacts?: number;
	  }
	| { readonly ok: false; readonly error: string };

export type DaemonImportSourceSnapshotResult =
	| {
			readonly ok: true;
			readonly imported?: number;
			readonly skippedLocalDiscordArtifacts?: number;
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
	readonly desktopCachePath?: string;
	readonly fullCache?: boolean;
	readonly channel?: readonly string[];
	readonly maxMessages?: string;
	readonly since?: string;
	readonly threads?: boolean;
	readonly archivedThreads?: boolean;
	readonly includePrivateArchivedThreads?: boolean;
	readonly members?: boolean;
	readonly attachments?: boolean;
	readonly attachmentText?: boolean;
	readonly maxAttachmentTextBytes?: string;
	readonly embeds?: boolean;
	readonly polls?: boolean;
	readonly threadMembers?: boolean;
	readonly mode?: "rest" | "gateway-tail" | "desktop-cache";
}

export interface ExportSourceSnapshotOptions {
	readonly out?: string;
	readonly includeLocalDiscord?: boolean;
}

export interface ImportSourceSnapshotOptions {
	readonly file: string;
	readonly includeLocalDiscord?: boolean;
}

export interface AddGitHubSourceOptions {
	readonly repo?: readonly string[];
	readonly tokenRef?: string;
	readonly name?: string;
	readonly resourceType?: readonly string[];
	readonly state?: "open" | "closed" | "all";
	readonly includeComments?: boolean;
	readonly label?: readonly string[];
	readonly docPath?: readonly string[];
	readonly maxItems?: string;
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
	const maxMessagesPerChannel = parseIntegerOption(options.maxMessages, "Discord max-messages");
	if (isParseError(maxMessagesPerChannel)) {
		console.error(chalk.red(`✗ ${maxMessagesPerChannel.error}`));
		process.exitCode = 1;
		return;
	}
	const maxAttachmentTextBytes = parseIntegerOption(
		options.maxAttachmentTextBytes,
		"Discord max-attachment-text-bytes",
	);
	if (isParseError(maxAttachmentTextBytes)) {
		console.error(chalk.red(`✗ ${maxAttachmentTextBytes.error}`));
		process.exitCode = 1;
		return;
	}
	const input: AddDiscordSourceInput = {
		guildIds,
		tokenRef: options.tokenRef ?? "",
		name: options.name,
		desktopCachePath: options.desktopCachePath,
		desktopCacheFullScan: options.fullCache,
		channelFilter: options.channel,
		maxMessagesPerChannel,
		includeThreads: options.threads,
		includeArchivedThreads: options.archivedThreads,
		includePrivateArchivedThreads: options.includePrivateArchivedThreads,
		includeMembers: options.members,
		includeAttachments: options.attachments,
		includeAttachmentText: options.attachmentText,
		maxAttachmentTextBytes,
		includeEmbeds: options.embeds,
		includePolls: options.polls,
		includeThreadMembers: options.threadMembers,
		since: options.since,
		syncMode: options.mode,
	};
	const daemonResult = await addSourceThroughDaemon(input, deps.addDiscordSourceToDaemon);
	if (daemonResult) {
		const handled = printDaemonAddSourceResult("Discord", daemonResult);
		if (handled) return;
	}

	const result = addDiscordSource(input, deps.agentsDir);
	if (result.ok === false) {
		console.error(chalk.red(`✗ ${result.error}`));
		process.exitCode = 1;
		return;
	}

	const verb = result.created ? "Added" : "Updated";
	console.log(chalk.green(`✓ ${verb} Discord source: ${result.source.name}`));
	console.log(chalk.dim(`  ${result.source.root}`));
	if (result.source.providerSettings?.syncMode === "desktop-cache") {
		console.log(chalk.dim("  mode: desktop-cache"));
		console.log(chalk.dim(`  full cache scan: ${result.source.providerSettings.desktopCacheFullScan === true}`));
	} else {
		console.log(chalk.dim(`  tokenRef: ${result.source.providerSettings?.tokenRef ?? ""}`));
	}
	console.log();
	console.log(chalk.dim("The daemon indexes Discord through the shared Sources job pipeline."));
	console.log(chalk.dim("Run `signet daemon restart` if the daemon is already running."));
}

export async function addGitHubSourceFromCli(options: AddGitHubSourceOptions, deps: SourcesDeps): Promise<void> {
	const maxItemsPerRepo = parseIntegerOption(options.maxItems, "GitHub max-items");
	if (isParseError(maxItemsPerRepo)) {
		console.error(chalk.red(`✗ ${maxItemsPerRepo.error}`));
		process.exitCode = 1;
		return;
	}
	const resourceTypes = options.resourceType?.filter(isGitHubResourceType);
	if (options.resourceType && resourceTypes?.length !== options.resourceType.length) {
		console.error(chalk.red("✗ GitHub resource types must be one of: issues, pulls, discussions, docs"));
		process.exitCode = 1;
		return;
	}
	const input: AddGitHubSourceInput = {
		repos: options.repo ?? [],
		tokenRef: options.tokenRef,
		name: options.name,
		resourceTypes,
		state: options.state,
		includeComments: options.includeComments,
		labels: options.label,
		docPaths: options.docPath,
		maxItemsPerRepo,
	};
	const daemonResult = await addSourceThroughDaemon(input, deps.addGitHubSourceToDaemon);
	if (daemonResult) {
		const handled = printDaemonAddSourceResult("GitHub", daemonResult);
		if (handled) return;
	}

	const result = addGitHubSource(input, deps.agentsDir);
	if (result.ok === false) {
		console.error(chalk.red(`✗ ${result.error}`));
		process.exitCode = 1;
		return;
	}

	const verb = result.created ? "Added" : "Updated";
	console.log(chalk.green(`✓ ${verb} GitHub source: ${result.source.name}`));
	console.log(chalk.dim(`  ${result.source.root}`));
	if (result.source.providerSettings?.tokenRef) {
		console.log(chalk.dim(`  tokenRef: ${result.source.providerSettings.tokenRef}`));
	}
	console.log();
	console.log(chalk.dim("The daemon indexes GitHub through the shared Sources job pipeline."));
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
			if (source.providerSettings.syncMode === "desktop-cache")
				console.log(chalk.dim(`  desktop cache: ${String(source.providerSettings.desktopCachePath ?? source.root)}`));
			if (source.providerSettings.syncMode !== "desktop-cache" && typeof source.providerSettings.tokenRef === "string")
				console.log(chalk.dim(`  tokenRef: ${source.providerSettings.tokenRef}`));
		}
		if (source.kind === "github" && source.providerSettings) {
			const repos = Array.isArray(source.providerSettings.repos)
				? source.providerSettings.repos.filter((entry) => typeof entry === "string")
				: [];
			if (repos.length > 0) console.log(chalk.dim(`  repos: ${repos.join(", ")}`));
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

export async function exportConfiguredSourceSnapshot(
	sourceId: string,
	options: ExportSourceSnapshotOptions,
	deps: SourcesDeps,
): Promise<void> {
	if (!deps.exportSourceSnapshotFromDaemon) {
		console.error(chalk.red("✗ Source snapshot export requires the Signet daemon API."));
		process.exitCode = 1;
		return;
	}
	const result = await deps.exportSourceSnapshotFromDaemon(sourceId, {
		includeLocalDiscord: options.includeLocalDiscord,
	});
	if (result.ok === false) {
		console.error(chalk.red(`✗ ${result.error}`));
		process.exitCode = 1;
		return;
	}

	const text = `${JSON.stringify(result.snapshot, null, 2)}\n`;
	if (options.out) {
		writeFileSync(options.out, text, "utf8");
		console.log(chalk.green(`✓ Exported source snapshot: ${sourceId}`));
		console.log(chalk.dim(`  ${options.out}`));
	} else {
		console.log(text.trimEnd());
	}
	console.error(chalk.dim(`Exported ${result.artifactCount ?? 0} source artifacts.`));
	if ((result.skippedLocalDiscordArtifacts ?? 0) > 0) {
		console.error(
			chalk.dim(
				`Skipped ${result.skippedLocalDiscordArtifacts} local Discord @me artifacts. Use --include-local-discord to include them.`,
			),
		);
	}
}

export async function importConfiguredSourceSnapshot(
	sourceId: string,
	options: ImportSourceSnapshotOptions,
	deps: SourcesDeps,
): Promise<void> {
	if (!deps.importSourceSnapshotToDaemon) {
		console.error(chalk.red("✗ Source snapshot import requires the Signet daemon API."));
		process.exitCode = 1;
		return;
	}
	let snapshot: unknown;
	try {
		snapshot = JSON.parse(readFileSync(options.file, "utf8")) as unknown;
	} catch (err) {
		console.error(chalk.red(`✗ Could not read source snapshot: ${err instanceof Error ? err.message : String(err)}`));
		process.exitCode = 1;
		return;
	}

	const result = await deps.importSourceSnapshotToDaemon(sourceId, snapshot, {
		includeLocalDiscord: options.includeLocalDiscord,
	});
	if (result.ok === false) {
		console.error(chalk.red(`✗ ${result.error}`));
		process.exitCode = 1;
		return;
	}
	console.log(chalk.green(`✓ Imported source snapshot: ${sourceId}`));
	console.log(chalk.dim(`  Imported ${result.imported ?? 0} source artifacts.`));
	if ((result.skippedLocalDiscordArtifacts ?? 0) > 0) {
		console.log(chalk.dim(`  Skipped ${result.skippedLocalDiscordArtifacts} local Discord @me artifacts.`));
	}
}

function isGitHubResourceType(value: string): value is "issues" | "pulls" | "discussions" | "docs" {
	return value === "issues" || value === "pulls" || value === "discussions" || value === "docs";
}

async function addSourceThroughDaemon<TInput>(
	input: TInput,
	addSourceToDaemon: ((input: TInput) => Promise<DaemonAddSourceResult>) | undefined,
): Promise<DaemonAddSourceResult | undefined> {
	if (!addSourceToDaemon) return undefined;
	const result = await addSourceToDaemon(input);
	if (result.ok === false && result.fallbackToLocal) {
		console.warn(chalk.yellow(`! Daemon add unavailable (${result.error}). Falling back to local config-only add.`));
		return undefined;
	}
	return result;
}

function printDaemonAddSourceResult(kind: string, result: DaemonAddSourceResult): boolean {
	if (result.ok === false) {
		console.error(chalk.red(`✗ ${result.error}`));
		process.exitCode = 1;
		return true;
	}

	const verb = result.created ? "Added" : "Updated";
	console.log(chalk.green(`✓ ${verb} ${kind} source: ${result.source.name}`));
	console.log(chalk.dim(`  ${result.source.root}`));
	if (
		typeof result.source.providerSettings?.tokenRef === "string" &&
		result.source.providerSettings.tokenRef.length > 0
	) {
		console.log(chalk.dim(`  tokenRef: ${result.source.providerSettings.tokenRef}`));
	}
	if (result.queued) console.log(chalk.dim("  queued initial index job"));
	return true;
}

type ParseIntegerResult = number | undefined | { readonly error: string };

function parseIntegerOption(value: string | undefined, label: string): ParseIntegerResult {
	if (value === undefined) return undefined;
	const trimmed = value.trim();
	if (!/^\d+$/.test(trimmed)) return { error: `${label} must be an integer` };
	return Number(trimmed);
}

function isParseError(value: ParseIntegerResult): value is { readonly error: string } {
	return typeof value === "object";
}
