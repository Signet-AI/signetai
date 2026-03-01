/**
 * Harness configuration.
 */

import type { VisualizationMode } from "./viz/types.js";

export interface HarnessConfig {
	readonly mode: "standalone" | "observer";
	readonly vizMode: VisualizationMode;
	readonly daemonHost: string;
	readonly daemonPort: number;
}

export function parseArgs(argv: ReadonlyArray<string>): HarnessConfig {
	const args = argv.slice(2);

	let mode: "standalone" | "observer" = "standalone";
	let vizMode: VisualizationMode = "inline";
	let daemonHost = process.env.SIGNET_HOST ?? "localhost";
	let daemonPort = Number(process.env.SIGNET_PORT) || 3850;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];

		if (arg === "--observer" || arg === "-o") {
			mode = "observer";
		} else if (arg === "--viz" || arg === "-v") {
			const next = args[i + 1];
			if (
				next === "inline" ||
				next === "hidden" ||
				next === "split"
			) {
				vizMode = next;
				i++;
			}
		} else if (arg === "--port" || arg === "-p") {
			const next = args[i + 1];
			if (next) {
				daemonPort = Number(next);
				i++;
			}
		} else if (arg === "--host") {
			const next = args[i + 1];
			if (next) {
				daemonHost = next;
				i++;
			}
		} else if (arg === "--help" || arg === "-h") {
			printHelp();
			process.exit(0);
		}
	}

	return { mode, vizMode, daemonHost, daemonPort };
}

function printHelp(): void {
	console.log(`
signet-harness — pipeline observability in a conversational CLI

usage:
  signet-harness [options]

modes:
  (default)          standalone agent with signet integration
  --observer, -o     observe pipeline events from another harness

options:
  --viz, -v MODE     visualization mode: inline, hidden, split (default: inline)
  --port, -p PORT    daemon port (default: 3850)
  --host HOST        daemon host (default: localhost)
  --help, -h         show this help
`);
}
