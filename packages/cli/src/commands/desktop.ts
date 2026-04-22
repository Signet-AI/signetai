import chalk from "chalk";
import type { Command } from "commander";
import type { DesktopBuildResult, DesktopLinuxInstallResult } from "../features/desktop.js";

interface DesktopDeps {
	readonly buildDesktopFromSource: (options?: { readonly repo?: string }) => DesktopBuildResult;
	readonly installDesktopFromSource: (options?: {
		readonly repo?: string;
		readonly skipBuild?: boolean;
	}) => DesktopLinuxInstallResult;
}

export function registerDesktopCommands(program: Command, deps: DesktopDeps): void {
	const desktop = program.command("desktop").description("Build and install the Signet Electron desktop app");

	desktop
		.command("build")
		.description("Build the Signet Electron desktop app from a source checkout")
		.option("--repo <path>", "Signet source checkout path (defaults to cwd, SIGNET_SOURCE_DIR, or ~/signet/signetai)")
		.action((options: { readonly repo?: string }) => {
			try {
				console.log(chalk.cyan("Building Signet desktop from source..."));
				const result = deps.buildDesktopFromSource({ repo: options.repo });
				console.log(chalk.green("✓ Signet desktop build complete"));
				console.log(chalk.dim(`  Source:   ${result.repo}`));
				console.log(chalk.dim(`  Artifacts: ${result.releaseDir}`));
			} catch (err) {
				console.error(chalk.red("Signet desktop build failed"));
				console.error(chalk.red(err instanceof Error ? err.message : String(err)));
				process.exit(1);
			}
		});

	desktop
		.command("install")
		.description("Build and install the Signet Electron desktop app")
		.option("--repo <path>", "Signet source checkout path (defaults to cwd, SIGNET_SOURCE_DIR, or ~/signet/signetai)")
		.option("--skip-build", "Install the newest existing desktop artifact without rebuilding")
		.action((options: { readonly repo?: string; readonly skipBuild?: boolean }) => {
			try {
				console.log(
					chalk.cyan(
						options.skipBuild ? "Installing Signet desktop artifact..." : "Building and installing Signet desktop...",
					),
				);
				const result = deps.installDesktopFromSource({ repo: options.repo, skipBuild: options.skipBuild });
				console.log(chalk.green("✓ Signet desktop installed"));
				console.log(chalk.dim(`  Source:   ${result.repo}`));
				console.log(chalk.dim(`  AppImage: ${result.appImage}`));
				console.log(chalk.dim(`  Launcher: ${result.binary}`));
				console.log(chalk.dim(`  Desktop:  ${result.desktopEntry}`));
				console.log(chalk.cyan("\n  Run: signet-desktop"));
			} catch (err) {
				console.error(chalk.red("Signet desktop install failed"));
				console.error(chalk.red(err instanceof Error ? err.message : String(err)));
				process.exit(1);
			}
		});
}
