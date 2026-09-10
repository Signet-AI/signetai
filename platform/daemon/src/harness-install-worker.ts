/** Isolated adapter installation. Connector classes remain the installation authority. */

import { resolveGlobalPackagePath, resolvePrimaryPackageManager } from "@signet/core";
import type { InstallResult } from "@signet/connector-base";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { createHarnessConnector, type HarnessAction } from "./harness-registry";

export { HARNESS_INSTALLERS } from "./harness-registry";

export interface HarnessInstallWorkerRequest {
	readonly id: string;
	readonly workspace: string;
	readonly action?: HarnessAction;
}

export type HarnessInstallWorkerEvent =
	| { readonly type: "complete"; readonly result: InstallResult }
	| { readonly type: "error"; readonly message: string };

async function installHarness(request: HarnessInstallWorkerRequest): Promise<InstallResult> {
	const id = request.id;
	const connector = await createHarnessConnector(id);
	const { OpenClawConnector } = await import("@signet/connector-openclaw");
	if (!connector) throw new Error("Unsupported harness installation");
	const workspace = request.workspace;
	if (!workspace) throw new Error("Missing resolved workspace");
	const action = request.action ?? "connect";
	// OpenClaw's package is installed by the existing CLI package owner. Never
	// report a working plugin when only its config exists.
	let pluginPath: string | null = null;
	const runtimePath =
		connector instanceof OpenClawConnector ? (connector.getConfiguredRuntimePath() ?? "plugin") : null;
	if (runtimePath === "plugin") {
		const manager = resolvePrimaryPackageManager({ agentsDir: workspace, env: process.env });
		pluginPath = resolveGlobalPackagePath(manager.family, "@signetai/signet-memory-openclaw") ?? null;
		if (!pluginPath || !existsSync(join(pluginPath, "dist", "index.js")))
			throw new Error(
				"OpenClaw needs its Signet plugin package. Run signet setup --non-interactive --harness openclaw, then retry here.",
			);
	}
	const result =
		action === "repair"
			? await connector.repair(workspace)
			: action === "reinitialize"
				? await connector.reinitialize(workspace)
				: connector instanceof OpenClawConnector
					? await connector.install(workspace, { configureWorkspace: false, runtimePath: runtimePath ?? "plugin" })
					: await connector.install(workspace);
	if (connector instanceof OpenClawConnector && pluginPath) connector.patchLoadPaths(dirname(pluginPath));
	if (!result.success) throw new Error(result.message);
	if (!connector.isInstalled())
		throw new Error("Integration files were written, but verification failed. Retry installation.");
	return result;
}

export async function runHarnessInstallWorker(request?: HarnessInstallWorkerRequest): Promise<InstallResult> {
	const resolvedRequest =
		request ?? ({ id: process.env.SIGNET_INSTALL_HARNESS ?? "", workspace: process.env.SIGNET_PATH ?? "" } as const);
	const result = await installHarness(resolvedRequest);
	if (request === undefined) process.stdout.write(`SIGNET_INSTALL_RESULT ${JSON.stringify(result)}\n`);
	return result;
}

async function runThreadWorker(): Promise<void> {
	if (parentPort === null) throw new Error("harness install worker requires a parent port");
	try {
		const result = await runHarnessInstallWorker(workerData as HarnessInstallWorkerRequest);
		parentPort.postMessage({ type: "complete", result } satisfies HarnessInstallWorkerEvent);
	} catch (error) {
		parentPort.postMessage({
			type: "error",
			message: error instanceof Error ? error.message : String(error),
		} satisfies HarnessInstallWorkerEvent);
	} finally {
		parentPort.close();
	}
}

if (!isMainThread && parentPort !== null) {
	void runThreadWorker();
}

if (
	isMainThread &&
	process.env.SIGNET_INSTALL_HARNESS &&
	/harness-install-worker\.(ts|js|mjs)$/.test(process.argv[1] ?? "")
) {
	await runHarnessInstallWorker();
}
