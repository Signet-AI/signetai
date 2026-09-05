/** Isolated adapter installation. Connector classes remain the installation authority. */

import { resolveGlobalPackagePath, resolvePrimaryPackageManager } from "@signet/core";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const HARNESS_INSTALLERS = {
	"claude-code": () => import("@signet/connector-claude-code").then((module) => module.ClaudeCodeConnector),
	codex: () => import("@signet/connector-codex").then((module) => module.CodexConnector),
	"hermes-agent": () => import("@signet/connector-hermes-agent").then((module) => module.HermesAgentConnector),
	opencode: () => import("@signet/connector-opencode").then((module) => module.OpenCodeConnector),
	openclaw: () => import("@signet/connector-openclaw").then((module) => module.OpenClawConnector),
	gemini: () => import("@signet/connector-gemini").then((module) => module.GeminiConnector),
	pi: () => import("@signet/connector-pi").then((module) => module.PiConnector),
	"oh-my-pi": () => import("@signet/connector-oh-my-pi").then((module) => module.OhMyPiConnector),
	kimi: () => import("@signet/connector-kimi").then((module) => module.KimiConnector),
	forge: () => import("@signet/connector-forge").then((module) => module.ForgeConnector),
};

export async function runHarnessInstallWorker(): Promise<void> {
	const id = process.env.SIGNET_INSTALL_HARNESS;
	const loadInstaller =
		id && Object.hasOwn(HARNESS_INSTALLERS, id) ? HARNESS_INSTALLERS[id as keyof typeof HARNESS_INSTALLERS] : null;
	const Installer = loadInstaller ? await loadInstaller() : null;
	const connector = Installer ? new Installer() : null;
	const { OpenClawConnector } = await import("@signet/connector-openclaw");
	if (!connector) throw new Error("Unsupported harness installation");
	const workspace = process.env.SIGNET_PATH;
	if (!workspace) throw new Error("Missing resolved workspace");
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
		connector instanceof OpenClawConnector
			? await connector.install(workspace, { configureWorkspace: false, runtimePath: runtimePath ?? "plugin" })
			: await connector.install(workspace);
	if (connector instanceof OpenClawConnector && pluginPath) connector.patchLoadPaths(dirname(pluginPath));
	if (!result.success) throw new Error(result.message);
	if (!connector.isInstalled())
		throw new Error("Integration files were written, but verification failed. Retry installation.");
	process.stdout.write(`SIGNET_INSTALL_RESULT ${JSON.stringify(result)}\n`);
}

if (process.env.SIGNET_INSTALL_HARNESS && /harness-install-worker\.(ts|js|mjs)$/.test(process.argv[1] ?? "")) {
	await runHarnessInstallWorker();
}
