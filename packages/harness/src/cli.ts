#!/usr/bin/env node

/**
 * signet-harness CLI entry point.
 *
 * Dispatches to standalone agent mode or observer mode
 * based on command-line arguments.
 */

import { parseArgs } from "./config.js";
import { runObserver } from "./modes/observer.js";
import { runStandalone } from "./modes/standalone.js";

async function main(): Promise<void> {
	const config = parseArgs(process.argv);

	if (config.mode === "observer") {
		await runObserver({
			vizMode: config.vizMode,
			daemonHost: config.daemonHost,
			daemonPort: config.daemonPort,
		});
	} else {
		await runStandalone({
			vizMode: config.vizMode,
			daemonHost: config.daemonHost,
			daemonPort: config.daemonPort,
		});
	}
}

main().catch((err) => {
	console.error("signet-harness:", err instanceof Error ? err.message : err);
	process.exit(1);
});
