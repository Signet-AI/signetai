import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const enabled = process.env.SIGNET_NATIVE_EMBEDDING_SMOKE === "1";
const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];

/** Resolve the compiled native binary to smoke-test.
 *  Honors an explicit SIGNET_NATIVE_SMOKE_BINARY override (release CI builds to
 *  dist/native/$RELEASE_ASSET); otherwise derives the asset name for the current
 *  platform so one test covers every release leg. */
function nativeSmokeBinary(): string {
	const override = process.env.SIGNET_NATIVE_SMOKE_BINARY;
	if (override) return override;
	const key = `${process.platform}-${process.arch}`;
	const name = `signet-${key}`;
	return join(root, "dist", "native", key.startsWith("win32-") ? `${name}.exe` : name);
}

function tempDir(): string {
	const path = mkdtempSync(join(tmpdir(), "signet-native-embedding-smoke-"));
	tempDirs.push(path);
	return path;
}

async function freePort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(0, "127.0.0.1", resolve);
	});
	const address = server.address();
	if (address === null || typeof address === "string") throw new Error("failed to allocate smoke-test port");
	const port = address.port;
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return port;
}

async function waitForHealth(origin: string, child: ChildProcessWithoutNullStreams): Promise<void> {
	const deadline = Date.now() + 30_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`native daemon exited before health check (status ${child.exitCode})`);
		try {
			const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) });
			if (response.ok) return;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error("native daemon did not become healthy within 30 seconds");
}

function floatVector(value: unknown): Float32Array {
	if (!(value instanceof Uint8Array)) throw new Error("embedding vector was not stored as bytes");
	return new Float32Array(value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength));
}

async function stopChild(child: ChildProcessWithoutNullStreams): Promise<void> {
	if (child.exitCode !== null) return;
	child.kill("SIGTERM");
	await Promise.race([
		new Promise<void>((resolve) => child.once("close", () => resolve())),
		Bun.sleep(5_000).then(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
		}),
	]);
}

const blackholeServers: Server[] = [];

/** TCP server that accepts a connection but never responds — makes an HTTP
 *  model fetch hang on response headers (a stalled CDN), hermetically. */
async function blackholeOrigin(): Promise<string> {
	return new Promise((resolve, reject) => {
		const server = createServer((socket) => {
			socket.on("error", () => {});
		});
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") return reject(new Error("blackhole did not bind"));
			blackholeServers.push(server);
			resolve(`http://127.0.0.1:${address.port}`);
		});
	});
}

afterEach(async () => {
	for (const child of children.splice(0)) await stopChild(child);
	for (const server of blackholeServers.splice(0)) server.close();
	for (const path of tempDirs.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("compiled native embedding runtime", () => {
	const smoke = enabled ? test : test.skip;

	smoke(
		"embeds and recalls a fixed sentence through the compiled native binary",
		async () => {
			const binary = nativeSmokeBinary();
			if (!existsSync(binary)) {
				throw new Error(`native binary not found at ${binary}; build it first (bun run build:native-bun)`);
			}
			const workspace = tempDir();
			writeFileSync(
				join(workspace, "agent.yaml"),
				"version: 1\nschema: signet/v1\nagent:\n  name: Native Embedding Smoke\nmemory:\n  database: memory/memories.db\n  pipelineV2:\n    enabled: false\nembedding:\n  provider: native\n  model: nomic-embed-text-v1.5\n  dimensions: 768\n",
			);

			const port = await freePort();
			const origin = `http://127.0.0.1:${port}`;
			const child = spawn(binary, [], {
				env: {
					...process.env,
					SIGNET_DAEMON_ENTRYPOINT: "1",
					SIGNET_PATH: workspace,
					SIGNET_PORT: String(port),
					SIGNET_BIND: "127.0.0.1",
					OLLAMA_HOST: "http://127.0.0.1:1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			children.push(child);
			const output: Buffer[] = [];
			child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
			child.stderr.on("data", (chunk) => output.push(Buffer.from(chunk)));

			try {
				await waitForHealth(origin, child);
				const sentence = "Issue 898 native packaging probe remembers the cobalt lighthouse.";
				const rememberResponse = await fetch(`${origin}/api/memory/remember`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ content: sentence, who: "runtime-smoke", importance: 0.9 }),
					signal: AbortSignal.timeout(10 * 60_000),
				});
				const remember = (await rememberResponse.json()) as { id?: unknown; embedded?: unknown; error?: unknown };
				expect(rememberResponse.ok).toBe(true);
				expect(remember.error).toBeUndefined();
				expect(remember.embedded).toBe(true);
				expect(typeof remember.id).toBe("string");

				const db = new Database(join(workspace, "memory", "memories.db"), { readonly: true });
				const row = db
					.query("SELECT dimensions, vector FROM embeddings WHERE source_type = 'memory' AND source_id = ?")
					.get(String(remember.id)) as { dimensions?: unknown; vector?: unknown } | null;
				db.close();
				expect(row?.dimensions).toBe(768);
				const vector = floatVector(row?.vector);
				expect(vector).toHaveLength(768);
				expect(Array.from(vector).every(Number.isFinite)).toBe(true);

				const recallResponse = await fetch(`${origin}/api/memory/recall`, {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ query: "cobalt lighthouse packaging probe", limit: 5 }),
					signal: AbortSignal.timeout(30_000),
				});
				const recallText = await recallResponse.text();
				expect(recallResponse.ok).toBe(true);
				expect(recallText).toContain(sentence);
			} catch (error) {
				const logs = Buffer.concat(output).toString("utf8");
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nNative daemon output:\n${logs}`, {
					cause: error,
				});
			}
		},
		12 * 60_000,
	);

	smoke(
		"keeps /health within SLA while the native embedding download is stalled (event-loop isolation)",
		async () => {
			// Regression guard for the shipped binary: the daemon's HTTP server
			// must stay responsive while the native embedding worker is stuck on
			// its first-run model download. We stall the fetch hermetically with
			// a local blackhole and assert /health latency through the window.
			const binary = nativeSmokeBinary();
			if (!existsSync(binary)) {
				throw new Error(`native binary not found at ${binary}; build it first (bun run build:native-bun)`);
			}
			const workspace = tempDir();
			writeFileSync(
				join(workspace, "agent.yaml"),
				"version: 1\nschema: signet/v1\nagent:\n  name: Native Embedding Isolation Smoke\nmemory:\n  database: memory/memories.db\n  pipelineV2:\n    enabled: false\nembedding:\n  provider: native\n  model: nomic-embed-text-v1.5\n  dimensions: 768\n",
			);
			const [port, blackhole] = await Promise.all([freePort(), blackholeOrigin()]);
			const origin = `http://127.0.0.1:${port}`;
			const child = spawn(binary, [], {
				env: {
					...process.env,
					SIGNET_DAEMON_ENTRYPOINT: "1",
					SIGNET_PATH: workspace,
					SIGNET_PORT: String(port),
					SIGNET_BIND: "127.0.0.1",
					// Redirect the transformers model fetch at the blackhole so the
					// embedding worker's first-run download hangs for the window.
					SIGNET_EMBEDDING_REMOTE_HOST: blackhole,
					OLLAMA_HOST: "http://127.0.0.1:1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			children.push(child);
			const output: Buffer[] = [];
			child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
			child.stderr.on("data", (chunk) => output.push(Buffer.from(chunk)));

			try {
				await waitForHealth(origin, child);
				const samples: number[] = [];
				const deadline = Date.now() + 5_000;
				while (Date.now() < deadline) {
					const t0 = Date.now();
					const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) });
					samples.push(Date.now() - t0);
					expect(res.ok).toBe(true);
					await Bun.sleep(250);
				}
				expect(samples.length).toBeGreaterThan(5);
				expect(Math.max(...samples)).toBeLessThan(1_000);
			} catch (error) {
				const logs = Buffer.concat(output).toString("utf8");
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nNative daemon output:\n${logs}`, {
					cause: error,
				});
			}
		},
		2 * 60_000,
	);
});
