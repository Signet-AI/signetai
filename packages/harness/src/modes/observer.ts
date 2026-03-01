/**
 * Observer mode.
 *
 * Attaches to the daemon's SSE log stream and renders pipeline events
 * in the terminal. No agent loop — just a live event viewer.
 */

import { DaemonClient } from "../daemon/client.js";
import { normalizeLogEntry } from "../daemon/observer.js";
import { EventBuffer } from "../viz/event-buffer.js";
import { formatEvents, formatStatusLine } from "../viz/formatters.js";
import type { VisualizationMode } from "../viz/types.js";

export interface ObserverOptions {
	readonly vizMode: VisualizationMode;
	readonly daemonHost: string;
	readonly daemonPort: number;
}

// ANSI codes
const CLEAR_SCREEN = "\x1b[2J\x1b[H";
const DIM = "\x1b[2m";
const BOLD = "\x1b[1m";
const RESET = "\x1b[0m";
const CYAN = "\x1b[36m";
const RED = "\x1b[31m";
const GREEN = "\x1b[32m";

export async function runObserver(options: ObserverOptions): Promise<void> {
	const client = new DaemonClient({
		host: options.daemonHost,
		port: options.daemonPort,
	});
	const eventBuffer = new EventBuffer(200);

	// Check daemon health
	const healthy = await client.health();
	if (!healthy) {
		console.error(
			`${RED}error:${RESET} signet daemon not reachable at ${options.daemonHost}:${options.daemonPort}`,
		);
		console.error(
			`${DIM}start it with: cd packages/daemon && bun run start${RESET}`,
		);
		process.exit(1);
	}

	// Print header
	console.log(CLEAR_SCREEN);
	console.log(
		`${BOLD}signet-harness${RESET} ${DIM}observer mode${RESET}`,
	);
	console.log(
		`${DIM}connected to daemon at ${options.daemonHost}:${options.daemonPort}${RESET}`,
	);
	console.log(
		`${DIM}watching for pipeline events... (ctrl+c to exit)${RESET}`,
	);
	console.log();

	// Get initial status
	try {
		const status = await client.status();
		console.log(
			`${GREEN}daemon:${RESET} ${status.status} ${DIM}v${status.version ?? "?"}${RESET}`,
		);
		if (status.pipeline) {
			console.log(
				`${CYAN}pipeline:${RESET} ${status.pipeline.mode ?? "unknown"} mode`,
			);
		}
		console.log();
	} catch {
		// non-fatal
	}

	// Connect to SSE log stream
	let lastRenderLineCount = 0;

	const stopLogs = client.streamLogs(
		(entry) => {
			const event = normalizeLogEntry(entry);
			if (event) {
				eventBuffer.push(event);
				render();
			}
		},
		(err) => {
			console.error(
				`${RED}log stream error:${RESET} ${err.message}`,
			);
		},
	);

	// Periodic telemetry poll for LLM call stats
	const telemetryInterval = setInterval(async () => {
		try {
			const events = await client.telemetryEvents("llm.generate", 5);
			for (const te of events) {
				const props = te.properties;
				if (!props) continue;
				eventBuffer.push({
					kind: "llm_call",
					provider: props.provider ?? "unknown",
					inputTokens: props.inputTokens ?? 0,
					outputTokens: props.outputTokens ?? 0,
					costUsd: props.totalCost ?? 0,
					durationMs: props.durationMs ?? 0,
					timestamp: new Date(te.timestamp).getTime(),
				});
			}
		} catch {
			// non-fatal
		}
	}, 10000);

	function render(): void {
		const recent = eventBuffer.getRecent(30);
		const lines = formatEvents(recent);
		const status = formatStatusLine(eventBuffer.getAll(), options.vizMode);

		// Move cursor up to overwrite previous render
		if (lastRenderLineCount > 0) {
			process.stdout.write(`\x1b[${lastRenderLineCount}A\x1b[J`);
		}

		const output = [...lines, "", status].join("\n");
		process.stdout.write(`${output}\n`);
		lastRenderLineCount = lines.length + 2;
	}

	// Handle exit
	const cleanup = (): void => {
		stopLogs();
		clearInterval(telemetryInterval);
		console.log(`\n${DIM}observer stopped${RESET}`);
		process.exit(0);
	};

	process.on("SIGINT", cleanup);
	process.on("SIGTERM", cleanup);

	// Keep alive
	await new Promise<never>(() => {});
}
