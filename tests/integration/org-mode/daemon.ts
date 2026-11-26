import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { buildHermeticEnvironment } from "../../../scripts/run-hermetic-tests";
import { resolveWorkspaceLayout } from "../../../platform/core/src/workspace-layout";
import { record, request, until } from "./http";

export const repo = resolve(import.meta.dir, "../../..");
export async function reservePort(): Promise<number> {
	return new Promise((accept, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			assert(address && typeof address !== "string");
			server.close((error) => (error ? reject(error) : accept(address.port)));
		});
	});
}
interface Proc {
	pid: number;
	ppid: number;
	pgid: number;
	args: string;
}
async function processes(): Promise<Proc[]> {
	const proc = Bun.spawn(["ps", "-eo", "pid=,ppid=,pgid=,args="], { stdout: "pipe" });
	const output = await new Response(proc.stdout).text();
	assert.equal(await proc.exited, 0);
	return output
		.trim()
		.split("\n")
		.map((line) => {
			const match = /^\s*(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/.exec(line);
			assert(match);
			return { pid: Number(match[1]), ppid: Number(match[2]), pgid: Number(match[3]), args: match[4] ?? "" };
		});
}
export async function terminateOwnedGroup(pid: number): Promise<number[]> {
	assert(pid && pid !== process.pid);
	const before = await processes();
	const group = before.find((entry) => entry.pid === pid);
	if (group) assert.equal(group.pgid, pid, "setsid did not create an owned process group");
	const descendants = new Set([pid]);
	for (let changed = true; changed; ) {
		changed = false;
		for (const entry of before)
			if (descendants.has(entry.ppid) && !descendants.has(entry.pid)) {
				descendants.add(entry.pid);
				changed = true;
			}
	}
	for (const entry of before) if (entry.pgid === pid) descendants.add(entry.pid);
	const signalGroup = (signal: NodeJS.Signals) => {
		try {
			process.kill(-pid, signal);
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
		}
	};
	const gone = async () => !(await processes()).some((entry) => descendants.has(entry.pid) || entry.pgid === pid);
	if (!(await gone())) signalGroup("SIGTERM");
	try {
		await until(gone, "daemon and DB-owner process group teardown", 10_000);
	} catch (error) {
		signalGroup("SIGKILL");
		await until(gone, "forced daemon and DB-owner cleanup", 5_000);
		throw new Error("Daemon teardown required SIGKILL; owned processes were reaped", { cause: error });
	}
	return [...descendants];
}

export class OrgDaemon {
	readonly workspace: string;
	readonly home: string;
	readonly origin: string;
	readonly env: NodeJS.ProcessEnv;
	stdout = "";
	stderr = "";
	child: ChildProcess | undefined;
	lastStoppedPids: number[] = [];
	private constructor(
		readonly root: string,
		readonly port: number,
	) {
		this.workspace = join(root, "workspace");
		this.home = join(root, "home");
		this.origin = `http://127.0.0.1:${port}`;
		this.env = {
			...buildHermeticEnvironment({ PATH: process.env.PATH, LANG: "C.UTF-8" }, root),
			TMPDIR: root,
			SIGNET_PATH: this.workspace,
			SIGNET_WORKSPACE: this.workspace,
			SIGNET_PORT: String(port),
			SIGNET_HOST: "127.0.0.1",
			SIGNET_BIND: "127.0.0.1",
			SIGNET_DAEMON_URL: this.origin,
			SIGNET_TELEMETRY_OPTOUT: "1",
			SIGNET_ANALYTICS_DISABLED: "1",
			SIGNET_DAEMON_ENTRYPOINT: "1",
			SIGNET_EMBEDDING_WARM_NATIVE: "false",
		};
		delete this.env.HERMES_HOME;
		delete this.env.CODEX_HOME;
	}
	static async create(): Promise<OrgDaemon> {
		const root = await mkdtemp(join(process.env.TMPDIR ?? tmpdir(), "signet-org-"));
		const daemon = new OrgDaemon(root, await reservePort());
		try {
			await mkdir(daemon.home, { recursive: true });
			await mkdir(join(daemon.workspace, "data"), { recursive: true });
			await writeFile(join(daemon.workspace, "workspace-layout.json"), JSON.stringify({ version: 2 }));
			const migration = await readFile(join(repo, "platform/daemon/src/config-migration.ts"), "utf8");
			const version = Math.max(
				...Array.from(migration.matchAll(/stampConfigVersion\(doc, (\d+)\)/g), (match) => Number(match[1])),
			);
			assert(version, "Cannot locate current configVersion in config-migration.ts");
			await writeFile(
				join(daemon.workspace, "agent.yaml"),
				`version: 1\nconfigVersion: ${version}\nembedding:\n  provider: none\nharnesses: []\ncapabilities:\n  identity:\n    mode: off\nhooks:\n  userPromptSubmit:\n    minScore: 0.01\nauth:\n  mode: team\nsearch:\n  rehearsal_enabled: false\n  temporal_prior_enabled: false\nmemory:\n  dreaming:\n    enabled: false\n  pipelineV2:\n    enabled: false\n    reranker:\n      enabled: false\n`,
			);
			const modulePath = join(repo, "platform/daemon/src/db-accessor.ts");
			const initializer = Bun.spawn(
				[
					process.execPath,
					"-e",
					`const {initDbAccessor}=await import(${JSON.stringify(modulePath)}); initDbAccessor(${JSON.stringify(join(daemon.workspace, "data/signet.db"))},{agentsDir:${JSON.stringify(daemon.workspace)}}); process.exit(0);`,
				],
				{ env: daemon.env, stdout: "pipe", stderr: "pipe" },
			);
			const [, output] = await Promise.all([
				new Response(initializer.stdout).text(),
				new Response(initializer.stderr).text(),
			]);
			assert.equal(await initializer.exited, 0, `Isolated DB initialization failed: ${output}`);
			await daemon.start();
			return daemon;
		} catch (error) {
			await daemon.dispose();
			throw error;
		}
	}
	async start(): Promise<void> {
		assert(!this.child, "Daemon already started");
		this.stdout = "";
		this.stderr = "";
		const binary = process.env.SIGNET_DAEMON_BIN;
		const args = binary ? [resolve(binary)] : [process.execPath, "src/daemon.ts"];
		const child = spawn("setsid", args, {
			cwd: join(repo, "platform/daemon"),
			env: this.env,
			stdio: ["ignore", "pipe", "pipe"],
		});
		this.child = child;
		child.stdout?.on("data", (chunk: Buffer) => {
			this.stdout = (this.stdout + chunk.toString()).slice(-256_000);
		});
		child.stderr?.on("data", (chunk: Buffer) => {
			this.stderr = (this.stderr + chunk.toString()).slice(-64_000);
		});
		let spawnError: Error | undefined;
		child.on("error", (error) => {
			spawnError = error;
		});
		try {
			await until(
				async () => {
					if (spawnError) throw spawnError;
					assert(child.exitCode === null && child.signalCode === null, `Daemon exited during boot: ${this.stderr}`);
					let health: Awaited<ReturnType<typeof request>>;
					try {
						health = await request(this.origin, "/health");
					} catch {
						return false;
					}
					if (health.status !== 200) return false;
					const body = record(health.body);
					assert.equal(body.pid, child.pid, "Health belongs to another daemon");
					assert.equal(body.agentsDir, this.workspace, "Daemon escaped isolated workspace");
					return (
						body.db === true &&
						body.dbOwner !== null &&
						typeof body.dbOwner === "object" &&
						record(body.dbOwner).state === "ready"
					);
				},
				`real daemon readiness; stderr: ${this.stderr}`,
				60_000,
			);
		} catch (error) {
			await this.stop();
			throw new Error(`Daemon boot failed: ${this.stderr}`, { cause: error });
		}
	}
	async stop(): Promise<void> {
		const child = this.child;
		if (!child) return;
		const pid = child.pid;
		assert(pid);
		try {
			this.lastStoppedPids = await terminateOwnedGroup(pid);
		} finally {
			if (!(await processes()).some((entry) => entry.pid === pid || entry.pgid === pid)) this.child = undefined;
		}
	}
	async restart(): Promise<void> {
		await this.stop();
		await this.start();
	}
	async setupToken(): Promise<string> {
		let token: string | undefined;
		await until(
			async () => {
				try {
					token = (await readFile(join(resolveWorkspaceLayout(this.workspace).runtime, "setup-token"), "utf8")).trim();
					return token.length >= 20;
				} catch {
					return false;
				}
			},
			"private one-time setup token",
			3000,
		);
		assert(token);
		return token;
	}
	async dispose(): Promise<void> {
		try {
			await this.stop();
		} finally {
			if (!this.child) await rm(this.root, { recursive: true, force: true });
		}
	}
}
