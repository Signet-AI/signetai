/** Isolated adapter installation. Connector classes remain the installation authority. */
import { ClaudeCodeConnector } from "@signet/connector-claude-code";
import { CodexConnector } from "@signet/connector-codex";
import { HermesAgentConnector } from "@signet/connector-hermes-agent";

import { ForgeConnector } from "@signet/connector-forge";
import { GeminiConnector } from "@signet/connector-gemini";
import { KimiConnector } from "@signet/connector-kimi";
import { OhMyPiConnector } from "@signet/connector-oh-my-pi";
import { OpenClawConnector } from "@signet/connector-openclaw";
import { OpenCodeConnector } from "@signet/connector-opencode";
import { PiConnector } from "@signet/connector-pi";
import { resolveGlobalPackagePath, resolvePrimaryPackageManager } from "@signet/core";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export const HARNESS_INSTALLERS = {
	"claude-code": ClaudeCodeConnector,
	codex: CodexConnector,
	"hermes-agent": HermesAgentConnector,
	opencode: OpenCodeConnector,
	openclaw: OpenClawConnector,
	gemini: GeminiConnector,
	pi: PiConnector,
	"oh-my-pi": OhMyPiConnector,
	kimi: KimiConnector,
	forge: ForgeConnector,
};

export async function runHarnessInstallWorker(): Promise<void> {
	const id = process.env.SIGNET_INSTALL_HARNESS;
	const Installer =
		id && Object.hasOwn(HARNESS_INSTALLERS, id) ? HARNESS_INSTALLERS[id as keyof typeof HARNESS_INSTALLERS] : null;
	const connector = Installer ? new Installer() : null;
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
