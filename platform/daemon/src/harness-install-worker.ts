/** Isolated adapter installation. Connector classes remain the installation authority. */
import { ClaudeCodeConnector } from "@signet/connector-claude-code";
import { CodexConnector } from "@signet/connector-codex";
import { HermesAgentConnector } from "@signet/connector-hermes-agent";

export async function runHarnessInstallWorker(): Promise<void> {
	const id = process.env.SIGNET_INSTALL_HARNESS;
	const connector =
		id === "claude-code"
			? new ClaudeCodeConnector()
			: id === "codex"
				? new CodexConnector()
				: id === "hermes-agent"
					? new HermesAgentConnector()
					: null;
	if (!connector) throw new Error("Unsupported harness installation");
	const workspace = process.env.SIGNET_PATH;
	if (!workspace) throw new Error("Missing resolved workspace");
	const result = await connector.install(workspace);
	if (!result.success) throw new Error(result.message);
	if (!connector.isInstalled())
		throw new Error("Integration files were written, but verification failed. Retry installation.");
	process.stdout.write(`SIGNET_INSTALL_RESULT ${JSON.stringify(result)}\n`);
}

if (process.env.SIGNET_INSTALL_HARNESS && /harness-install-worker\.(ts|js|mjs)$/.test(process.argv[1] ?? "")) {
	await runHarnessInstallWorker();
}
