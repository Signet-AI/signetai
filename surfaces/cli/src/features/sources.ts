import { addGitHubSource, addObsidianSource, loadSourcesConfig, removeSource } from "@signet/core";
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

export async function addGitHubRepoSource(
	options: {
		readonly repos?: readonly string[];
		readonly name?: string;
		readonly tokenRef?: string;
		readonly types?: string;
		readonly state?: string;
		readonly comments?: boolean;
		readonly docPaths?: readonly string[];
		readonly maxItems?: string;
	},
	deps: SourcesDeps,
): Promise<void> {
	const repos = options.repos ?? [];
	if (repos.length === 0) {
		console.error(chalk.red("✗ --repos is required (e.g. --repos owner/repo owner/*)"));
		process.exitCode = 1;
		return;
	}
	const validTypes = new Set(["issues", "pulls", "discussions", "docs"]);
	const resourceTypes = options.types
		? options.types
				.split(",")
				.map((t) => t.trim())
				.filter(Boolean)
		: undefined;
	if (resourceTypes && resourceTypes.length > 0) {
		const invalid = resourceTypes.filter((t) => !validTypes.has(t));
		if (invalid.length > 0) {
			console.error(chalk.red(`✗ Invalid resource types: ${invalid.join(", ")}. Must be one of: issues, pulls, discussions, docs`));
			process.exitCode = 1;
			return;
		}
	}
	const maxItems = options.maxItems ? Number(options.maxItems) : undefined;

	const result = addGitHubSource(
		{
			repos,
			name: options.name,
			tokenRef: options.tokenRef,
			resourceTypes,
			state: options.state as "open" | "closed" | "all" | undefined,
			includeComments: options.comments,
			docPaths: options.docPaths,
			maxItemsPerRepo: maxItems,
		},
		deps.agentsDir,
	);
	if (result.ok === false) {
		console.error(chalk.red(`✗ ${result.error}`));
		process.exitCode = 1;
		return;
	}

	const verb = result.created ? "Added" : "Updated";
	console.log(chalk.green(`✓ ${verb} GitHub source: ${result.source.name}`));
	console.log(chalk.dim(`  repos: ${repos.join(", ")}`));
	if (options.tokenRef) console.log(chalk.dim(`  token: ${options.tokenRef}`));
	console.log(chalk.dim(`  types: ${(resourceTypes ?? ["issues", "pulls", "discussions", "docs"]).join(", ")}`));
	console.log();
	console.log(chalk.dim("The daemon indexes GitHub sources on startup and polls every 5 minutes."));
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
