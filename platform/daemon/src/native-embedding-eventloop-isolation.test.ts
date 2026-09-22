import { Database } from "bun:sqlite";
import { afterEach, describe, expect, it } from "bun:test";
import { type ChildProcessByStdio, spawn } from "node:child_process";
import type { Readable } from "node:stream";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { type Server, createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

type TestChild = ChildProcessByStdio<null, Readable, Readable>;

const daemonScript = join(import.meta.dir, "daemon.ts");
const tempDirs: string[] = [];
const children: TestChild[] = [];
const servers: Server[] = [];

type ChildExit = {
	readonly code: number | null;
	readonly signal: NodeJS.Signals | null;
};

type ChildLifecycle = {
	readonly stdout: Buffer[];
	readonly stderr: Buffer[];
	readonly closed: Promise<ChildExit>;
	readonly agentsDir: string;
};

const MAX_DIAGNOSTIC_LINES = 80;
const MAX_DIAGNOSTIC_CHARS = 16_000;

function captureChildLifecycle(child: TestChild, agentsDir: string): ChildLifecycle {
	const stdout: Buffer[] = [];
	const stderr: Buffer[] = [];
	const closed = new Promise<ChildExit>((resolve) => {
		child.once("close", (code, signal) => resolve({ code, signal }));
	});
	child.stdout.on("data", (chunk: Buffer) => stdout.push(chunk));
	child.stderr.on("data", (chunk: Buffer) => stderr.push(chunk));
	return { stdout, stderr, closed, agentsDir };
}

function readDiagnosticArtifact(path: string, missing: string): string {
	try {
		const content = readFileSync(path, "utf8").trim();
		return content || "<empty>";
	} catch (error) {
		return `${missing}: ${error instanceof Error ? error.message : String(error)}`;
	}
}

function readDaemonLogTail(agentsDir: string): string {
	const logDir = join(agentsDir, ".daemon", "logs");
	try {
		const contents = readdirSync(logDir)
			.filter((name) => name.endsWith(".log"))
			.sort()
			.map((name) => `--- ${name} ---\n${readFileSync(join(logDir, name), "utf8")}`)
			.join("\n");
		if (!contents) return "<no daemon log files>";
		return contents.split(/\r?\n/).slice(-MAX_DIAGNOSTIC_LINES).join("\n").slice(-MAX_DIAGNOSTIC_CHARS);
	} catch (error) {
		return `<daemon log unavailable: ${error instanceof Error ? error.message : String(error)}>`;
	}
}

function formatChildExitError(
	status: number | null,
	signal: NodeJS.Signals | null,
	stdout: string,
	stderr: string,
	agentsDir: string,
): Error {
	const signalDetails = signal === null ? "" : `, signal ${signal}`;
	const stdoutDetails = stdout.trim() || "<empty>";
	const stderrDetails = stderr.trim() || "<empty>";
	const lifecycle = readDiagnosticArtifact(join(agentsDir, ".daemon", "lifecycle.json"), "<lifecycle unavailable>");
	const logTail = readDaemonLogTail(agentsDir);
	return new Error(
		[
			`daemon exited before health (status ${status ?? "unknown"}${signalDetails})`,
			`stdout:\n${stdoutDetails}`,
			`stderr:\n${stderrDetails}`,
			`lifecycle.json:\n${lifecycle}`,
			`daemon log tail:\n${logTail}`,
		].join("\n\n"),
	);
}

async function childExitError(child: TestChild, lifecycle: ChildLifecycle): Promise<Error> {
	const exit = await lifecycle.closed;
	const stdout = Buffer.concat(lifecycle.stdout).toString("utf8");
	const stderr = Buffer.concat(lifecycle.stderr).toString("utf8");
	return formatChildExitError(child.exitCode ?? exit.code, exit.signal, stdout, stderr, lifecycle.agentsDir);
}

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

type BlackholeEndpoint = {
	readonly origin: string;
	readonly connectionCount: () => number;
};
async function blackholeOrigin(): Promise<BlackholeEndpoint> {
	return new Promise((resolve, reject) => {
		let connectionCount = 0;
		const server = createServer((socket) => {
			connectionCount += 1;
			socket.on("error", () => {});
		});
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (address === null || typeof address === "string") return reject(new Error("no port"));
			servers.push(server);
			resolve({
				origin: `http://127.0.0.1:${address.port}`,
				connectionCount: () => connectionCount,
			});
		});
	});
}

async function waitForBlackholeConnection(
	endpoint: BlackholeEndpoint,
	child: TestChild,
	lifecycle: ChildLifecycle,
	deadlineMs = 60_000,
): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (endpoint.connectionCount() > 0) return;
		if (child.exitCode !== null || child.signalCode !== null) throw await childExitError(child, lifecycle);
		await Bun.sleep(100);
	}
	throw new Error(`native embedding worker did not reach the blackhole within ${deadlineMs}ms`);
}

async function waitForHealth(
	origin: string,
	child: TestChild,
	lifecycle: ChildLifecycle,
	deadlineMs = 30_000,
): Promise<void> {
	const deadline = Date.now() + deadlineMs;
	while (Date.now() < deadline) {
		if (child.exitCode !== null || child.signalCode !== null) throw await childExitError(child, lifecycle);
		try {
			const res = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) });
			if (res.ok) return;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error("daemon did not become healthy in time");
}

process.env.SIGNET_TELEMETRY_OPTOUT = "1";

describe("native embedding event-loop isolation (e2e)", () => {
	it("preserves child output and daemon diagnostics when startup exits before health", async () => {
		const agentsDir = tempDir();
		mkdirSync(join(agentsDir, ".daemon", "logs"), { recursive: true });
		writeFileSync(join(agentsDir, ".daemon", "lifecycle.json"), '{"state":"error","reason":"error:startup"}');
		writeFileSync(join(agentsDir, ".daemon", "logs", "signet-2026-08-13.log"), "fatal startup detail\n");
		const child = spawn(
			process.execPath,
			["-e", 'console.log("startup output"); console.error("startup failure"); process.exit(1)'],
			{
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		const lifecycle = captureChildLifecycle(child, agentsDir);
		const error = await childExitError(child, lifecycle);

		expect(error.message).toContain("status 1");
		expect(error.message).toContain("startup output");
		expect(error.message).toContain("startup failure");
		expect(error.message).toContain('{"state":"error","reason":"error:startup"}');
		expect(error.message).toContain("fatal startup detail");
	});

	it("reports a signal-terminated child instead of waiting for the health timeout", async () => {
		const child = spawn(process.execPath, ["-e", 'process.kill(process.pid, "SIGTERM")'], {
			stdio: ["ignore", "pipe", "pipe"],
		});
		const lifecycle = captureChildLifecycle(child, tempDir());

		const result = waitForHealth("http://127.0.0.1:1", child, lifecycle, 2_000);
		if (process.platform === "win32") {
			await expect(result).rejects.toThrow(/status 1\)/);
			return;
		}
		await expect(result).rejects.toThrow(/status unknown, signal SIGTERM/);
	});
	it("/health stays within SLA while the embedding worker is stuck on a model download", async () => {
		const agentsDir = tempDir();
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		const database = new Database(join(agentsDir, "memory", "memories.db"));
		database.close();
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			[
				"memory:",
				"  pipelineV2:",
				"    enabled: false",
				"embedding:",
				"  provider: native",
				"  model: nomic-ai/nomic-embed-text-v1.5",
				"  dimensions: 768",
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
				SIGNET_EMBEDDING_REMOTE_HOST: blackhole.origin,
				SIGNET_DAEMON_ENTRYPOINT: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		children.push(child);
		const lifecycle = captureChildLifecycle(child, agentsDir);
		child.stdout.on("data", () => {});

		await waitForHealth(origin, child, lifecycle);
		await waitForBlackholeConnection(blackhole, child, lifecycle);
		expect(blackhole.connectionCount()).toBeGreaterThan(0);
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
		const max = Math.max(...samples);
		expect(max).toBeLessThan(1_000);
	}, 120_000);
});
