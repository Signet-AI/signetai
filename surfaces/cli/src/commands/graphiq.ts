import type { DaemonFetch } from "../lib/daemon.js";
import { resolve } from "node:path";
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

export function registerGraphiqCommands(
	program: Command,
	deps: GraphiqDeps & { readonly fetchFromDaemon: DaemonFetch },
): void {
	const host = async (path: string, method: string, body: unknown, fallback?: () => Promise<unknown>) => {
		const mode = await deps.fetchFromDaemon<{ mode: string }>("/api/mode");
		if (mode?.mode !== "team" && fallback) {
			await fallback();
			return;
		}
		if (typeof body === "object" && body !== null && Reflect.get(body, "purgeIndexes") === true)
			throw new Error("Index purging is unavailable through the running organization daemon");
		const result = await deps.fetchFromDaemon(path, {
			method,
			...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
		});
		if (!result) throw new Error("GraphIQ host operation requires a running daemon");
		console.log(JSON.stringify(result, null, 2));
	};
	program
		.command("index <path>")
		.description("Index a project with GraphIQ and make it the active code context")
		.option("--no-install", "Do not offer/install GraphIQ if it is missing")
		.action((path: string, options: { install?: boolean }) =>
			host("/api/graphiq/index", "POST", { path: resolve(path) }, () => indexWithGraphiq(path, options, deps)),
		);

	const graphiq = program.command("graphiq").description("Manage the optional GraphIQ code retrieval plugin");

	graphiq
		.command("install")
		.description("Install and enable the managed GraphIQ plugin")
		.action(() => host("/api/graphiq/install", "POST", {}, () => installGraphiqPlugin(deps)));

	graphiq
		.command("status")
		.description("Show GraphIQ status for the active indexed project")
		.action(() => host("/api/graphiq/status", "GET", undefined, () => showGraphiqStatus(deps)));

	graphiq
		.command("update")
		.description("Update the managed GraphIQ binary on the daemon host")
		.action(() => host("/api/graphiq/update", "POST", {}));

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
		.action((options: { purgeIndexes?: boolean }) =>
			host("/api/graphiq/uninstall", "POST", { purgeIndexes: options.purgeIndexes ?? false }, async () =>
				uninstallGraphiqPlugin(options, deps),
			),
		);
}
