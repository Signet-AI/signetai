import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";
import { MIGRATIONS } from "../platform/core/src/migrations";

const root = join(import.meta.dir, "..");
const enabled = process.env.SIGNET_NATIVE_EMBEDDING_SMOKE === "1";
const tempDirs: string[] = [];
const children: ChildProcessWithoutNullStreams[] = [];
const CHILD_KILL_REAP_MS = 2_000;
const CHILD_TERM_GRACE_MS = 2_000;

interface StoppableChild {
	readonly exitCode: number | null;
	kill(signal: "SIGTERM" | "SIGKILL"): void;
	once(event: "close", listener: () => void): void;
}

interface StopTimings {
	readonly termGraceMs: number;
	readonly killReapMs: number;
}

function closesWithin(closed: Promise<true>, timeoutMs: number): Promise<boolean> {
	return new Promise((resolve) => {
		const timer = setTimeout(() => resolve(false), timeoutMs);
		void closed.then(() => {
			clearTimeout(timer);
			resolve(true);
		});
	});
}

/** Resolve the compiled native binary to smoke-test.
 *  Honors an explicit SIGNET_NATIVE_SMOKE_BINARY override (release CI builds to
 *  dist/native/$RELEASE_ASSET); otherwise derives the asset name for the current
 *  platform so one test covers every release leg.
 *
 *  The override is resolved against the repo root and returned as an absolute
 *  path. Release CI sets a relative value (`./dist/native/$RELEASE_ASSET`);
 *  without absolutizing, the `signet sync` spawnSync below fails with ENOENT
 *  because it runs with `cwd: <tempdir>`, and Node resolves a relative command
 *  path against that cwd rather than the repo root. */
export function nativeSmokeBinary(): string {
	const override = process.env.SIGNET_NATIVE_SMOKE_BINARY;
	if (override) return resolve(root, override);
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

async function stopChild(
	child: StoppableChild,
	timings: StopTimings = { termGraceMs: CHILD_TERM_GRACE_MS, killReapMs: CHILD_KILL_REAP_MS },
): Promise<void> {
	if (child.exitCode !== null) return;
	const closed = new Promise<true>((resolve) => child.once("close", () => resolve(true)));
	child.kill("SIGTERM");
	if (await closesWithin(closed, timings.termGraceMs)) return;

	if (child.exitCode === null) child.kill("SIGKILL");
	if (!(await closesWithin(closed, timings.killReapMs))) {
		throw new Error(`native smoke child did not close within ${timings.killReapMs}ms after SIGKILL`);
	}
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
}, 30_000);

/** Start an OAuth login against the compiled binary and read the SSE stream
 *  until the provider's first interactive event (auth_url, select, error, or
 *  done) arrives, then abort the stream so the daemon cancels the session. */
async function startOAuthLoginSse(origin: string, providerId: string): Promise<string> {
	const controller = new AbortController();
	const response = await fetch(`${origin}/api/inference/oauth/login/${providerId}`, {
		method: "POST",
		signal: controller.signal,
	});
	if (!response.body) throw new Error(`OAuth login ${providerId}: response has no body`);
	const reader = response.body.getReader();
	const decoder = new TextDecoder();
	let text = "";
	while (!/event: (auth|select|error|done)\b/.test(text)) {
		const next = await reader.read();
		if (next.done) break;
		text += decoder.decode(next.value, { stream: true });
	}
	controller.abort();
	return text;
}

process.env.SIGNET_TELEMETRY_OPTOUT = "1"; // keep CI/test daemons out of the PostHog project

describe("native smoke binary path", () => {
	test("resolves a relative SIGNET_NATIVE_SMOKE_BINARY override to an absolute path", () => {
		const prev = process.env.SIGNET_NATIVE_SMOKE_BINARY;
		process.env.SIGNET_NATIVE_SMOKE_BINARY = join(".", "dist", "native", "signet-test-binary");
		try {
			const binary = nativeSmokeBinary();
			expect(isAbsolute(binary), binary).toBe(true);
			expect(binary).toBe(join(root, "dist", "native", "signet-test-binary"));
		} finally {
			if (prev === undefined) delete process.env.SIGNET_NATIVE_SMOKE_BINARY;
			else process.env.SIGNET_NATIVE_SMOKE_BINARY = prev;
		}
	});

	test("respects an absolute SIGNET_NATIVE_SMOKE_BINARY override unchanged", () => {
		const prev = process.env.SIGNET_NATIVE_SMOKE_BINARY;
		const abs = join(root, "dist", "native", "signet-abs-binary");
		process.env.SIGNET_NATIVE_SMOKE_BINARY = abs;
		try {
			expect(nativeSmokeBinary()).toBe(abs);
		} finally {
			if (prev === undefined) delete process.env.SIGNET_NATIVE_SMOKE_BINARY;
			else process.env.SIGNET_NATIVE_SMOKE_BINARY = prev;
		}
	});
});

describe("native embedding smoke teardown", () => {
	test("waits for close after escalating a SIGTERM-resistant child", async () => {
		const signals: string[] = [];
		let closed = false;
		let onClose: (() => void) | undefined;
		const child: StoppableChild = {
			exitCode: null,
			kill(signal) {
				signals.push(signal);
				if (signal === "SIGKILL") {
					setTimeout(() => {
						closed = true;
						onClose?.();
					}, 10);
				}
			},
			once(_event, listener) {
				onClose = listener;
			},
		};

		await stopChild(child, { termGraceMs: 1, killReapMs: 100 });

		expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
		expect(closed).toBe(true);
	});

	test("fails within the reap bound when a killed child never closes", async () => {
		const child: StoppableChild = {
			exitCode: null,
			kill() {},
			once() {},
		};

		await expect(stopChild(child, { termGraceMs: 1, killReapMs: 5 })).rejects.toThrow(
			"native smoke child did not close within 5ms after SIGKILL",
		);
	});
});

describe("compiled native embedding runtime", () => {
	const smoke = enabled ? test : test.skip;

	smoke(
		"serves embedded dashboard assets, connector assets, and fresh workspace migrations",
		async () => {
			const binary = nativeSmokeBinary();
			if (!existsSync(binary)) {
				throw new Error(`native binary not found at ${binary}; build it first (bun run build:native-bun)`);
			}

			const home = tempDir();
			const workspace = join(home, ".agents");
			const hermesHome = join(home, ".hermes");
			mkdirSync(workspace, { recursive: true });
			mkdirSync(hermesHome, { recursive: true });
			writeFileSync(
				join(workspace, "agent.yaml"),
				"version: 1\nschema: signet/v1\nagent:\n  name: Native Release Smoke\nharnesses:\n  - hermes-agent\nmemory:\n  database: memory/memories.db\n  pipelineV2:\n    enabled: false\nembedding:\n  provider: none\n",
			);

			const port = await freePort();
			const origin = `http://127.0.0.1:${port}`;
			const daemonEnv: NodeJS.ProcessEnv = {
				...process.env,
				HOME: home,
				HERMES_HOME: hermesHome,
				SIGNET_DAEMON_ENTRYPOINT: "1",
				SIGNET_PATH: workspace,
				SIGNET_PORT: String(port),
				SIGNET_BIND: "127.0.0.1",
				SIGNET_SKIP_AGENT_REGISTER: "1",
			};
			// biome-ignore lint/performance/noDelete: prove the binary materializes its own embedded connector tree
			delete daemonEnv.SIGNET_CONNECTOR_ASSETS_DIR;
			// biome-ignore lint/performance/noDelete: avoid source-install connector fallbacks
			delete daemonEnv.SIGNET_DIR;
			// biome-ignore lint/performance/noDelete: prove the binary serves its own embedded dashboard, not a leaked on-disk dir
			delete daemonEnv.SIGNET_DASHBOARD_DIR;

			const child = spawn(binary, [], { env: daemonEnv, stdio: ["ignore", "pipe", "pipe"] });
			children.push(child);
			const output: Buffer[] = [];
			child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
			child.stderr.on("data", (chunk) => output.push(Buffer.from(chunk)));

			try {
				await waitForHealth(origin, child);

				const dashboard = await fetch(`${origin}/`, { signal: AbortSignal.timeout(10_000) });
				expect(dashboard.ok).toBe(true);
				expect(dashboard.headers.get("content-type")).toContain("text/html");
				const dashboardHtml = await dashboard.text();
				expect(dashboardHtml.toLowerCase()).toContain("<!doctype html>");
				// React dashboard (Vite) serves root-relative hashed assets; the
				// SvelteKit marker ("/_app/immutable/") was retired with #948.
				expect(dashboardHtml).toContain("/assets/");

				const db = new Database(join(workspace, "memory", "memories.db"), { readonly: true });
				const applied = db.query("SELECT version FROM schema_migrations ORDER BY version").all() as Array<{
					version: number;
				}>;
				db.close();
				expect(applied.map((migration) => migration.version)).toEqual(MIGRATIONS.map((migration) => migration.version));

				const cliEnv = { ...daemonEnv };
				// biome-ignore lint/performance/noDelete: run the CLI rather than another daemon entrypoint
				delete cliEnv.SIGNET_DAEMON_ENTRYPOINT;
				const sync = spawnSync(binary, ["sync"], {
					cwd: home,
					env: cliEnv,
					encoding: "utf8",
					timeout: 30_000,
				});
				expect(sync.status, `${sync.stdout}\n${sync.stderr}`).toBe(0);
				for (const name of ["__init__.py", "client.py", "plugin.yaml", "README.md", "signet.install.json"]) {
					expect(existsSync(join(hermesHome, "plugins", "signet", name)), name).toBe(true);
				}
			} catch (error) {
				const logs = Buffer.concat(output).toString("utf8");
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nNative daemon output:\n${logs}`, {
					cause: error,
				});
			}
		},
		60_000,
	);

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

describe("compiled native OAuth sign-in", () => {
	const smoke = enabled ? test : test.skip;

	// Regression for dashboard sign-in failing with
	// "ResolveMessage: Cannot find module './anthropic.js'" (and
	// './openai-codex.js') from '/$bunfs/root/signet-linux-x64'. pi-ai 0.81+
	// lazy-loads its OAuth flows through a variable-specifier dynamic import
	// that survives into the compiled binary and resolves against the bundle
	// root, where no such module exists. The daemon must register pi-ai's
	// statically bundled flows (registerBunOAuthFlows) before any login.
	smoke(
		"starts anthropic and openai-codex sign-in without the pi-ai dynamic-import failure",
		async () => {
			const binary = nativeSmokeBinary();
			if (!existsSync(binary)) {
				throw new Error(`native binary not found at ${binary}; build it first (bun run build:native-bun)`);
			}
			const home = tempDir();
			const workspace = join(home, ".agents");
			mkdirSync(workspace, { recursive: true });
			writeFileSync(
				join(workspace, "agent.yaml"),
				"version: 1\nschema: signet/v1\nagent:\n  name: Native OAuth Smoke\nmemory:\n  database: memory/memories.db\n  pipelineV2:\n    enabled: false\nembedding:\n  provider: none\n",
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
					SIGNET_SKIP_AGENT_REGISTER: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			children.push(child);
			const output: Buffer[] = [];
			child.stdout.on("data", (chunk) => output.push(Buffer.from(chunk)));
			child.stderr.on("data", (chunk) => output.push(Buffer.from(chunk)));

			try {
				await waitForHealth(origin, child);

				// Anthropic: auth_url via a local callback server, emitted
				// before any outbound call.
				const anthropic = await startOAuthLoginSse(origin, "anthropic");
				expect(anthropic).toContain("event: auth");
				expect(anthropic).toContain("https://claude.ai/oauth/authorize");
				expect(anthropic).not.toContain("Cannot find module");

				// OpenAI Codex: login-method select prompt; device-code polling
				// only starts after the user picks a method, so this is hermetic.
				const codex = await startOAuthLoginSse(origin, "openai-codex");
				expect(codex).toContain("event: select");
				expect(codex).not.toContain("Cannot find module");
			} catch (error) {
				const logs = Buffer.concat(output).toString("utf8");
				throw new Error(`${error instanceof Error ? error.message : String(error)}\n\nNative daemon output:\n${logs}`, {
					cause: error,
				});
			}
		},
		60_000,
	);
});
