/**
 * Event-loop occupancy probe loaded into the daemon process itself.
 *
 * The daemon is spawned with `bun --preload <this file>` so the probe shares
 * the exact event loop whose stalls we are judging. Sampling uses
 * perf_hooks.monitorEventLoopDelay with a 20ms resolution. Under Bun the
 * histogram reports NANOSECONDS (Node semantics); every value is converted
 * to milliseconds on read.
 *
 * The probe is passive by design and judge-safe:
 *  - it never imports daemon code and never touches the database;
 *  - it binds its own loopback HTTP listener on SIGNET_PHASE_D_PROBE_PORT
 *    (separate from the daemon port) exposing GET /probe and POST /phase;
 *  - its 1s drain timer only reads histogram aggregates, so the probe cannot
 *    itself produce a block remotely close to the 2000ms budget.
 *
 * Judged series: the per-drain-interval MAX event-loop delay. If the loop is
 * blocked for N ms inside a second, that second's max is >= N. A block that
 * spans a drain boundary is charged to the window where the drain finally
 * ran, so a single >= budget block is always recorded at least once.
 */

import { monitorEventLoopDelay } from "node:perf_hooks";
import { createServer } from "node:http";

interface LoopBlockEvent {
	/** Wall-clock time the window was observed, ms since epoch. */
	readonly at: number;
	/** Measured delay of the window in ms. */
	readonly ms: number;
	/** Coarse phase marker: "startup" | "run" (set by the harness). */
	phase: string;
}

const BUDGET_MS = 2_000;
const SAMPLE_FLOOR_MS = 50;

const blocks: LoopBlockEvent[] = [];
const samples: number[] = [];
let phase = "startup";

const histogram = monitorEventLoopDelay({ resolution: 20 });
histogram.enable();

const drain = setInterval(() => {
	// The histogram API exposes aggregates, not per-window values.
	const maxMs = histogram.max / 1e6;
	if (Number.isFinite(maxMs) && maxMs > SAMPLE_FLOOR_MS) {
		samples.push(maxMs);
		if (maxMs >= BUDGET_MS) blocks.push({ at: Date.now(), ms: maxMs, phase });
	}
	histogram.reset();
}, 1_000);
if (drain.unref) drain.unref();

process.on("exit", () => {
	try {
		histogram.disable();
	} catch {}
});

function report(): Record<string, unknown> {
	return {
		enabled: true,
		phase,
		budgetMs: BUDGET_MS,
		sampleFloorMs: SAMPLE_FLOOR_MS,
		units: "ms",
		blocks,
		sampleCount: samples.length,
		samples,
		pid: process.pid,
	};
}

const portRaw = Bun.env.SIGNET_PHASE_D_PROBE_PORT;
const port = portRaw ? Number.parseInt(portRaw, 10) : Number.NaN;
if (Number.isInteger(port) && port > 0) {
	const server = createServer((req, res) => {
		const url = req.url ?? "/";
		if (req.method === "GET" && url === "/probe") {
			res.writeHead(200, { "content-type": "application/json" });
			res.end(JSON.stringify(report()));
			return;
		}
		if (req.method === "POST" && url === "/phase") {
			let body = "";
			req.on("data", (chunk: Buffer) => {
				body += chunk.toString();
				if (body.length > 1024) req.destroy();
			});
			req.on("end", () => {
				try {
					const parsed = JSON.parse(body) as { phase?: unknown };
					if (parsed.phase === "run" || parsed.phase === "startup") phase = parsed.phase;
					res.writeHead(200, { "content-type": "application/json" });
					res.end(JSON.stringify({ phase }));
				} catch {
					res.writeHead(400);
					res.end("bad json");
				}
			});
			return;
		}
		res.writeHead(404);
		res.end("not found");
	});
	server.listen(port, "127.0.0.1");
	server.unref();
} else {
	// No port configured: samples are still recorded in-process; a local run
	// can read them via the daemon process's globalThis if needed.
	console.error("[phase-d-probe] SIGNET_PHASE_D_PROBE_PORT not set; probe server disabled");
}
