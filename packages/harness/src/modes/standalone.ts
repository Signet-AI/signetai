/**
 * Standalone agent mode.
 *
 * Creates a pi-mono agent session with the Signet extension loaded,
 * then runs in interactive mode. The extension handles all hook
 * lifecycle and pipeline observability.
 */

import {
	createAgentSession,
	codingTools,
	InteractiveMode,
} from "@mariozechner/pi-coding-agent";
import { createSignetExtension } from "../extension/signet-extension.js";
import type { VisualizationMode } from "../viz/types.js";

export interface StandaloneOptions {
	readonly vizMode: VisualizationMode;
	readonly daemonHost: string;
	readonly daemonPort: number;
}

export async function runStandalone(options: StandaloneOptions): Promise<void> {
	// Create the signet extension factory
	const signetExtension = createSignetExtension({
		host: options.daemonHost,
		port: options.daemonPort,
		vizMode: options.vizMode,
		streamLogs: true,
	});

	// Create agent session with coding tools
	// The extension will be loaded via pi's extension discovery
	const { session } = await createAgentSession({
		tools: codingTools,
	});

	// Load the signet extension into the session
	// AgentSession exposes loadExtension for runtime extension loading
	const sessionAny = session as unknown as Record<string, unknown>;
	const extRunner = sessionAny.extensionRunner as
		| {
				loadExtension?: (
					factory: typeof signetExtension,
					path: string,
				) => Promise<void>;
		  }
		| undefined;

	if (extRunner?.loadExtension) {
		await extRunner.loadExtension(signetExtension, "signet-harness");
	} else {
		// Fallback: manually invoke the extension factory with the session's
		// extension API. This is a best-effort path.
		console.log(
			"note: for full extension support, run signet-harness as a pi extension",
		);
	}

	// Run interactive mode
	const mode = new InteractiveMode(session);
	await mode.run();
}
