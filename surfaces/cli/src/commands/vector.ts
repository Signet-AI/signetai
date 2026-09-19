import type { Command } from "commander";
import chalk from "chalk";

interface VectorDeps {
	readonly AGENTS_DIR: string;
	readonly signetLogo: () => string;
}

/**
 * Vector storage is daemon-owned. The native daemon currently has no migration
 * route, so this command must fail closed rather than opening memories.db.
 */
export function registerVectorCommands(program: Command, deps: VectorDeps): void {
	program
		.command("migrate-vectors")
		.description("Migrate existing vectors (native daemon route required)")
		.option("--keep-blobs")
		.option("--remove-zvec")
		.option("--dry-run")
		.option("--rollback")
		.action(() => {
			console.log(deps.signetLogo());
			console.log(chalk.bold("  Vector Migration\n"));
			throw new Error("Vector migration is not supported by the native daemon yet; no local database was modified.");
		});
}
