import type { Command } from "commander";
import {
	type GraphiqDeps,
	indexWithGraphiq,
	installGraphiqPlugin,
	runGraphiqDeadCode,
	runGraphiqDoctor,
	showGraphiqStatus,
	uninstallGraphiqPlugin,
	upgradeGraphiqIndex,
} from "../features/graphiq.js";

export function registerGraphiqCommands(program: Command, deps: GraphiqDeps): void {
	program
		.command("index <path>")
		.description("Index a project with GraphIQ and make it the active code context")
		.option("--no-install", "Do not offer/install GraphIQ if it is missing")
		.action((path: string, options: { install?: boolean }) => indexWithGraphiq(path, options, deps));

	const graphiq = program.command("graphiq").description("Manage the optional GraphIQ code retrieval plugin");

	graphiq
		.command("install")
		.description("Install and enable the managed GraphIQ plugin")
		.action(() => installGraphiqPlugin(deps));

	graphiq
		.command("status")
		.description("Show GraphIQ status for the active indexed project")
		.action(() => showGraphiqStatus(deps));

	graphiq
		.command("doctor")
		.description("Diagnose the active GraphIQ index")
		.action(() => runGraphiqDoctor(deps));

	graphiq
		.command("upgrade-index")
		.description("Rebuild stale GraphIQ artifacts for the active project")
		.action(() => upgradeGraphiqIndex(deps));

	graphiq
		.command("dead-code")
		.description("Find unreachable code in the active project")
		.action(() => runGraphiqDeadCode(deps));

	graphiq
		.command("uninstall")
		.description("Disable the managed GraphIQ plugin")
		.option("--purge-indexes", "Also delete known project .graphiq directories")
		.action((options: { purgeIndexes?: boolean }) => uninstallGraphiqPlugin(options, deps));
}
