import { monitorEventLoopDelay } from "node:perf_hooks";
import { createServer } from "node:http";

interface LoopBlockEvent {
	readonly at: number;
	readonly ms: number;
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
	console.error("[phase-d-probe] SIGNET_PHASE_D_PROBE_PORT not set; probe server disabled");
}
