/** Regression coverage for issue #1780 at the real daemon composition boundary. */
import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "bun:sqlite";
import { runMigrations } from "@signet/core";

interface OwnerHealth {
	readonly state: string;
	readonly generation: number;
}

interface DatabaseIntegrity {
	readonly ownerState: string | null;
	readonly ownerGeneration: number | null;
}

interface HealthResponse {
	readonly db: boolean;
	readonly dbOwner: OwnerHealth | null;
	readonly databaseIntegrity: DatabaseIntegrity;
}

let workspace: string | null = null;
let daemon: ChildProcess | null = null;

async function freePort(): Promise<number> {
	const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = server.port;
	await server.stop(true);
	return port;
}

function daemonOutput(output: readonly string[]): string {
	return output.join("").slice(-4_000);
}

async function stopDaemon(): Promise<void> {
	const child = daemon;
	daemon = null;
	if (child === null || child.exitCode !== null) return;
	await new Promise<void>((resolveExit) => {
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			resolveExit();
		};
		const forceKill = setTimeout(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
			finish();
		}, 5_000);
		child.once("exit", () => {
			clearTimeout(forceKill);
			finish();
		});
		child.kill("SIGTERM");
	});
}

async function fetchHealth(origin: string, output: readonly string[]): Promise<HealthResponse> {
	const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(2_000) });
	if (!response.ok) throw new Error(`health returned ${response.status}\n${daemonOutput(output)}`);
	return (await response.json()) as HealthResponse;
}

async function waitForHealth(origin: string, output: readonly string[]): Promise<HealthResponse> {
	const deadline = Date.now() + 30_000;
	let lastError = "no response";
	while (Date.now() < deadline) {
		if (daemon?.exitCode !== null) throw new Error(`daemon exited\n${daemonOutput(output)}`);
		try {
			return await fetchHealth(origin, output);
		} catch (error) {
			lastError = error instanceof Error ? error.message : String(error);
			await Bun.sleep(100);
		}
	}
	throw new Error(`daemon did not serve /health: ${lastError}\n${daemonOutput(output)}`);
}

afterEach(async () => {
	await stopDaemon();
	if (workspace !== null) rmSync(workspace, { recursive: true, force: true });
	workspace = null;
});

describe("DB-owner health startup composition", () => {
	test("registers the real owner resource before the source daemon serves health", async () => {
		workspace = mkdtempSync(join(tmpdir(), "signet-db-owner-health-startup-"));
		const agentsDir = workspace;
		const home = join(workspace, "home");
		mkdirSync(join(agentsDir, ".daemon", "logs"), { recursive: true });
		mkdirSync(join(agentsDir, "memory"), { recursive: true });
		mkdirSync(home, { recursive: true });
		writeFileSync(
			join(agentsDir, "agent.yaml"),
			"agent:\n  name: db-owner-health-startup\nembedding:\n  provider: none\nmemory:\n  pipelineV2:\n    enabled: false\n",
		);
		const db = new Database(join(agentsDir, "memory", "memories.db"));
		runMigrations(db);
		db.close();

		const port = await freePort();
		const origin = `http://127.0.0.1:${port}`;
		const output: string[] = [];
		daemon = spawn(process.execPath, [join(import.meta.dir, "daemon.ts")], {
			cwd: resolve(import.meta.dir, "../../.."),
			env: {
				...process.env,
				HOME: home,
				USERPROFILE: home,
				XDG_CONFIG_HOME: join(home, ".config"),
				CODEX_HOME: join(home, ".codex"),
				CLAUDE_CONFIG_DIR: join(home, ".claude"),
				HERMES_HOME: join(home, ".hermes"),
				SIGNET_PATH: agentsDir,
				SIGNET_PORT: String(port),
				SIGNET_HOST: "127.0.0.1",
				SIGNET_BIND: "127.0.0.1",
				SIGNET_TELEMETRY_OPTOUT: "1",
				SIGNET_DAEMON_ENTRYPOINT: "1",
				SIGNET_SKIP_AGENT_REGISTER: "1",
			},
			stdio: ["ignore", "pipe", "pipe"],
		});
		daemon.stdout?.on("data", (chunk: Buffer) => output.push(chunk.toString()));
		daemon.stderr?.on("data", (chunk: Buffer) => output.push(chunk.toString()));

		const firstHealth = await waitForHealth(origin, output);
		expect(firstHealth.db).toBe(true);
		if (firstHealth.dbOwner === null) throw new Error("DB owner health was not registered before /health served");
		expect(firstHealth.databaseIntegrity.ownerState).toBe(firstHealth.dbOwner.state);
		expect(firstHealth.databaseIntegrity.ownerGeneration).toBe(firstHealth.dbOwner.generation);
	}, 60_000);
});
