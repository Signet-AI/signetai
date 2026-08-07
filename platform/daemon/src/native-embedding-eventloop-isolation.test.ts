/**
 * End-to-end regression: the daemon's HTTP server (incl. /health) must stay
 * responsive while the native embedding provider is stuck on its first-run
 * model download.
 *
 * This is the test the bug class escaped. The prior in-process implementation
 * ran ONNX-WASM init + model fetch on the main event loop, so an unreachable
 * model CDN wedged the whole daemon — /health timed out even though the
 * process was alive and the port was bound. The unit tests mocked
 * @huggingface/transformers and so never exercised any of that.
 *
 * Here we spawn the REAL daemon (source mode) configured for native
 * embeddings, point the model fetch at a local TCP blackhole (accepts the
 * connection, never responds — simulates a stalled CDN, fully hermetic, no
 * real network), and poll /health through the window where the embedding
 * worker is grinding. Every response must return within the SLA. The main
 * event loop can't be starved because the grinding now happens in a worker.
 */

import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const daemonScript = join(import.meta.dir, "daemon.ts");
const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const servers: Server[] = [];

afterEach(async () => {
	for (const child of children.splice(0)) {
		if (child.exitCode === null) {
			child.kill("SIGTERM");
			await new Promise<void>((resolve) => {
				const t = setTimeout(() => {
					child.kill("SIGKILL");
					resolve();
				}, 2_000);
				child.once("close", () => {
					clearTimeout(t);
					resolve();
				});
			});
		}
	}
	for (const server of servers.splice(0)) server.close();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "signet-embedding-isolation-"));
	tempDirs.push(dir);
	return dir;
}

async function freePort(): Promise<number> {
	return new Promise((resolve, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") return reject(new Error("no port"));
			const port = address.port;
			server.close((err) => (err ? reject(err) : resolve(port)));
		});
	});
}

/** A TCP server that accepts connections but never responds — makes an HTTP
 *  fetch hang indefinitely on response headers (a stalled CDN), hermetically. */
async function blackholeOrigin(): Promise<string> {
	return new Promise((resolve, reject) => {
		const server = createServer((socket) => {
			// Hold the connection open without ever writing a response.
			socket.on("error", () => {});
		});
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") return reject(new Error("no port"));
			servers.push(server);
			resolve(`http://127.0.0.1:${address.port}`);
		});
	});
}

async function waitForHealth(
	origin: string,
	child: ChildProcessWithoutNullStreams,
	deadlineMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`daemon exited before health (status ${child.exitCode})`);
		try {
			const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) });
			if (res.ok) return;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error("daemon did not become healthy in time");
}

process.env.SIGNET_TELEMETRY_OPTOUT = "1"; // keep CI/test daemons out of the PostHog project

describe("native embedding event-loop isolation (e2e)", () => {
	// Generous timeout: daemon startup + a 5s probe window.
	it("/health stays within SLA while the embedding worker is stuck on a model download", async () => {
		const agentsDir = tempDir();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			[
				"memory:",
				"  pipelineV2:",
				"    enabled: false",
				"  embedding:",
				"    provider: native",
				"    model: nomic-ai/nomic-embed-text-v1.5",
				"    dimensions: 768",
				"",
			].join("\n"),
		);

		const [port, blackhole] = await Promise.all([freePort(), blackholeOrigin()]);
		const origin = `http://127.0.0.1:${port}`;

		const child = spawn(process.execPath, [daemonScript], {
			env: {
				...process.env,
				SIGNET_PORT: String(port),
				SIGNET_PATH: agentsDir,
				SIGNET_BIND: "127.0.0.1",
				// Redirect the transformers model fetch to the blackhole so the
				// embedding worker's first-run download hangs for the whole probe.
				SIGNET_EMBEDDING_REMOTE_HOST: blackhole,
				// Avoid crosstalk with the user's real daemon/services.
				SIGNET_DAEMON_ENTRYPOINT: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.push(child);

		// Surface daemon failures fast.
		child.stderr.on("data", () => {});
		child.stdout.on("data", () => {});

		await waitForHealth(origin, child);

		// The daemon's startup probe (daemon.ts) fires checkEmbeddingProvider
		// at boot, so the embedding worker is now grinding against the
		// blackhole. Poll /health through the window and assert the SLA.
		const samples: number[] = [];
		const probeDeadline = Date.now() + 5_000;
		while (Date.now() < probeDeadline) {
			const t0 = Date.now();
			const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) });
			samples.push(Date.now() - t0);
			expect(res.ok).toBe(true);
			await Bun.sleep(250);
		}

		expect(samples.length).toBeGreaterThan(5);
		// /health is a cheap SELECT 1; it must return well under a second even
		// while the embedding worker is hung. (Before the fix this timed out.)
		const max = Math.max(...samples);
		expect(max).toBeLessThan(1_000);

		// Prove the embedding worker actually started its (stuck) init against
		// the blackhole — otherwise this test could pass trivially with the
		// provider idle. The handle forwards worker logs through the daemon
		// logger, which writes to the agents-dir log.
		const logDir = join(agentsDir, ".daemon", "logs");
		let logText = "";
		try {
			for (const name of readdirSync(logDir)) {
				if (name.endsWith(".log")) logText += readFileSync(join(logDir, name), "utf8");
			}
		} catch {
			// logs may live elsewhere on some platforms; the SLA assertion above
			// is the load-bearing guard.
		}
		expect(logText).toMatch(/nomic-embed|Initializing.*nomic|embedding/i);
	}, 60_000);
});
