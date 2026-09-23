import type { Command } from "commander";
import { spawn } from "node:child_process";
import { closeSync, existsSync, fstatSync, mkdirSync, openSync, statSync, unlinkSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
	inspectRootGit,
	mergeSignetGitignoreEntries,
	resolveDaemonRuntime,
	resolveWorkspaceLayout,
	serializeWorkspaceLayout,
} from "@signet/core";
import { MigrationEngine, type MigrationDeps, type Layout } from "../lib/migration-engine.js";
import { createDatabase, verifyMigrationDatabaseRows } from "../sqlite.js";
import { readConfiguredWorkspacePath, resolveAgentsDir, writeConfiguredWorkspacePath } from "../lib/workspace.js";
import {
	resolveDaemonJsNodePath,
	resolveDaemonJsWasmPath,
	resolveDaemonLaunchCommand,
	resolveDaemonPathForRuntime,
	readManagedDaemonPid,
	stopManagedDaemonProcess,
} from "../lib/runtime.js";

export type MigrationCommandDeps = {
	createEngine?: (options: { source?: string; destination?: string }) => MigrationEngine;
	stdout?: Pick<Console, "log" | "error">;
};

function contained(base: string, candidate: string): boolean {
	const r = relative(resolve(base), resolve(candidate));
	return r === "" || (!r.startsWith(`..${sep}`) && r !== "..");
}

function descriptorRelative(base: string, candidate: string): string {
	return relative(resolve(base), resolve(candidate)).split(sep).join("/");
}

function withinDescriptorPath(parent: string, candidate: string): boolean {
	return candidate === parent || candidate.startsWith(`${parent}/`);
}

export async function requestMigrationDrain(
	baseUrl: string,
	fetchImpl: typeof fetch = fetch,
	expectedWorkspace?: string,
	expectedPid?: number | null,
): Promise<string[] | null> {
	if (expectedWorkspace) {
		let status: Response;
		try {
			status = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/status`, {
				signal: AbortSignal.timeout(1500),
			});
		} catch {
			return null;
		}
		if (!status.ok) throw new Error(`daemon workspace identity probe failed (${status.status})`);
		const identity: unknown = await status.json();
		if (!identity || typeof identity !== "object") throw new Error("daemon workspace identity is malformed");
		const agentsDir = Reflect.get(identity, "agentsDir");
		if (typeof agentsDir !== "string" || !agentsDir) throw new Error("daemon workspace identity is unavailable");
		if (resolve(agentsDir) !== resolve(expectedWorkspace)) return null;
		if (typeof expectedPid !== "number" || Reflect.get(identity, "pid") !== expectedPid)
			return ["daemon:pid-unverified"];
	}
	let response: Response;
	try {
		response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/workspace/migration-control/drain`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{}",
			signal: AbortSignal.timeout(35_000),
		});
	} catch {
		return null;
	}
	if (response.status === 404) return null;
	if (!response.ok) throw new Error(`daemon migration drain failed (${response.status})`);
	const body: unknown = await response.json();
	if (!body || typeof body !== "object") throw new Error("daemon migration drain returned malformed JSON");
	const blockersValue = Reflect.get(body, "blockers");
	if (!Array.isArray(blockersValue)) throw new Error("daemon migration drain omitted blockers");
	const blockers = blockersValue.map((entry) => {
		if (!entry || typeof entry !== "object") throw new Error("daemon migration drain returned malformed blocker");
		const owner = Reflect.get(entry, "owner");
		if (typeof owner !== "string" || owner.length === 0)
			throw new Error("daemon migration drain returned malformed blocker owner");
		return owner;
	});
	const closed = Reflect.get(body, "closed");
	if (closed !== true && blockers.length === 0) return ["daemon:drain-incomplete"];
	return blockers;
}

async function reserveLoopbackPort(): Promise<number> {
	return await new Promise<number>((resolvePort, reject) => {
		const server = createServer();
		server.once("error", reject);
		server.listen(0, "127.0.0.1", () => {
			const address = server.address();
			if (!address || typeof address === "string") {
				server.close();
				reject(new Error("failed to reserve a loopback port"));
				return;
			}
			server.close((error) => (error ? reject(error) : resolvePort(address.port)));
		});
	});
}

export async function verifyDestinationDaemon(
	destination: string,
	options: {
		readonly launchCommand?: readonly string[];
		readonly readinessTimeoutMs?: number;
	} = {},
): Promise<void> {
	const port = await reserveLoopbackPort();
	const entrypoint = process.argv[1];
	const runtime = resolveDaemonRuntime(undefined, process.env);
	const daemonPath = resolveDaemonPathForRuntime(runtime, process.env);
	const sourceTestCommand =
		process.env.SIGNET_DAEMON_ENTRYPOINT === "0" && entrypoint && /\.(?:[cm]?[jt]s)$/.test(entrypoint)
			? [process.execPath, entrypoint]
			: [];
	const command =
		options.launchCommand ??
		(daemonPath ? resolveDaemonLaunchCommand(daemonPath, process.env, runtime) : sourceTestCommand);
	if (!command[0]) throw new Error("destination daemon launch command is empty");
	if (!options.launchCommand && !daemonPath && sourceTestCommand.length === 0)
		throw new Error("destination daemon artifact is unavailable");
	const nodePath = daemonPath ? resolveDaemonJsNodePath(daemonPath) : null;
	const wasmPath = daemonPath ? resolveDaemonJsWasmPath(daemonPath) : null;
	const child = spawn(command[0], command.slice(1), {
		cwd: process.cwd(),
		env: {
			...process.env,
			SIGNET_PATH: destination,
			SIGNET_WORKSPACE: "",
			SIGNET_PORT: String(port),
			SIGNET_HOST: "127.0.0.1",
			SIGNET_BIND: "127.0.0.1",
			SIGNET_DAEMON_ENTRYPOINT: "1",
			SIGNET_DAEMON_RUNTIME: runtime,
			SIGNET_EMBEDDING_WARM_NATIVE: "false",
			SIGNET_TELEMETRY_OPTOUT: "1",
			SIGNET_ANALYTICS_DISABLED: "1",
			...(nodePath ? { NODE_PATH: nodePath } : {}),
			...(wasmPath ? { SIGNET_TIKTOKEN_WASM_PATH: wasmPath } : {}),
		},
		stdio: ["ignore", "pipe", "pipe"],
		detached: true,
	});
	let output = "";
	child.stdout?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	child.stderr?.on("data", (chunk: Buffer) => {
		output += chunk.toString();
	});
	const exited = new Promise<void>((resolveExit) => child.once("exit", () => resolveExit()));
	let verificationError: unknown;
	let stopped = false;
	try {
		const deadline = Date.now() + (options.readinessTimeoutMs ?? 20_000);
		let ready = false;
		let readinessReasons: string[] = [];
		while (Date.now() < deadline) {
			if (child.exitCode !== null)
				throw new Error(`destination daemon exited before readiness (${child.exitCode}): ${output.slice(-2000)}`);
			try {
				const response = await fetch(`http://127.0.0.1:${port}/health/ready`, {
					signal: AbortSignal.timeout(500),
				});
				const body: unknown = await response.json();
				if (response.ok && body && typeof body === "object" && Reflect.get(body, "status") === "ready") {
					ready = true;
					break;
				}
				const reasons = body && typeof body === "object" ? Reflect.get(body, "reasons") : undefined;
				if (Array.isArray(reasons))
					readinessReasons = reasons.filter((reason): reason is string => typeof reason === "string");
			} catch {}
			await sleep(50);
		}
		if (!ready) {
			const reasons = readinessReasons.length > 0 ? readinessReasons.join(", ") : output.slice(-2000);
			throw new Error(`destination daemon readiness timed out: ${reasons}`);
		}
	} catch (error) {
		verificationError = error;
	} finally {
		const childPid = child.pid;
		if (child.exitCode === null && childPid !== undefined) process.kill(-childPid, "SIGTERM");
		stopped = await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)]);
		if (!stopped) {
			try {
				if (childPid !== undefined) process.kill(-childPid, "SIGKILL");
			} catch {}
			stopped = await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)]);
		}
	}
	if (!stopped) throw new Error("destination daemon did not terminate after verification");
	if (verificationError) throw verificationError;
}

function defaultEngine(options: { source?: string; destination?: string }): MigrationEngine {
	const source = resolve(options.source ?? resolveAgentsDir().path);
	const destination = resolve(
		options.destination ?? join(dirname(source), `${source.split("/").pop() ?? "workspace"}-v2`),
	);
	const sourceLayout = resolveWorkspaceLayout(source);
	const rootGitMode = inspectRootGit(source).mode;
	if (sourceLayout.version !== 1) throw new Error("workspace is not a v1 layout");
	const state = process.env.XDG_STATE_HOME
		? join(process.env.XDG_STATE_HOME, "signet", "migrations")
		: join(homedir(), ".local", "state", "signet", "migrations");
	const legacyDefaults = {
		database: join(source, "memory", "memories.db"),
		transcripts: join(source, "memory"),
		runtime: join(source, ".daemon"),
		cache: join(source, "memory", "cache"),
		files: join(source, "files"),
		imports: join(source, "memory", "imports"),
		secrets: join(source, ".secrets"),
		skills: join(source, "skills"),
		data: join(source, "memory"),
	} as const;
	const overrides = Object.fromEntries(
		Object.entries(legacyDefaults)
			.filter(([key, value]) => sourceLayout[key as keyof typeof legacyDefaults] !== value)
			.map(([key]) => [
				key,
				contained(source, sourceLayout[key as keyof typeof legacyDefaults])
					? relative(source, sourceLayout[key as keyof typeof legacyDefaults])
					: sourceLayout[key as keyof typeof legacyDefaults],
			]),
	);
	const databasePath = contained(source, sourceLayout.database)
		? descriptorRelative(source, sourceLayout.database)
		: undefined;
	const customRoots = Object.entries(legacyDefaults)
		.filter(([key, value]) => key !== "database" && sourceLayout[key as keyof typeof legacyDefaults] !== value)
		.map(([key]) => sourceLayout[key as keyof typeof legacyDefaults])
		.filter((value) => contained(source, value))
		.map((value) => descriptorRelative(source, value));
	const mapDestinationPath = (path: string): string | undefined => {
		if (path === "workspace-layout.json") return undefined;
		if (databasePath && (path === databasePath || path === `${databasePath}-wal` || path === `${databasePath}-shm`))
			return undefined;
		if (customRoots.some((root) => withinDescriptorPath(root, path))) return path;
		if (path.startsWith("memory/cache/")) return `cache/${path.slice("memory/cache/".length)}`;
		if (path.startsWith("memory/imports/")) return `data/imports/${path.slice("memory/imports/".length)}`;
		const harnessTranscript = /^memory\/([^/]+)\/transcripts\/(.+)$/.exec(path);
		if (harnessTranscript) return `transcripts/${harnessTranscript[1]}/${harnessTranscript[2]}`;
		if (/^memory\/[^/]+--(?:summary|transcript|compaction|manifest)\.md$/.test(path))
			return `transcripts/${path.slice("memory/".length)}`;
		if (path.startsWith("memory/")) return `data/legacy-memory/${path.slice("memory/".length)}`;
		if (path.startsWith(".daemon/")) return `runtime/${path.slice(".daemon/".length)}`;
		return path;
	};
	const resolver = {
		resolve: (): Layout => ({ version: 1, root: source, destination }),
		capture: async () => readConfiguredWorkspacePath() ?? undefined,
		current: async () => readConfiguredWorkspacePath() ?? source,
		cutover: async () => {
			writeConfiguredWorkspacePath(destination);
		},
		verifyDestination: async () => {
			const layout = resolveWorkspaceLayout(destination);
			if (layout.version !== 2) throw new Error("destination layout verification failed");
			if (existsSync(layout.database)) {
				const db = createDatabase(layout.database);
				try {
					const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
					if (row?.quick_check !== "ok") throw new Error("destination database verification failed");
				} finally {
					db.close();
				}
			}
			await verifyDestinationDaemon(destination);
		},
	};
	const leasePath = join(state, `${source.replaceAll("/", "_")}.lease`);
	const acquireLease = async () => {
		mkdirSync(state, { recursive: true, mode: 0o700 });
		let fd: number;
		try {
			fd = openSync(leasePath, "wx", 0o600);
		} catch {
			throw new Error("another migration is already running");
		}
		return {
			release: async () => {
				try {
					const current = statSync(leasePath);
					const owned = fstatSync(fd);
					if (current.dev === owned.dev && current.ino === owned.ino) unlinkSync(leasePath);
				} finally {
					closeSync(fd);
				}
			},
		};
	};
	const deps: MigrationDeps = {
		resolver,
		lease: { acquire: acquireLease },
		writers: {
			drain: async () => {
				const pid = readManagedDaemonPid(source);
				const blockers = await requestMigrationDrain(
					process.env.SIGNET_DAEMON_URL ?? "http://127.0.0.1:3850",
					fetch,
					source,
					pid,
				);
				if (blockers && blockers.length > 0) return { owners: blockers };
				if (pid === null) return { owners: [] };
				if (blockers === null) return { owners: ["daemon:workspace-unverified"] };
				await stopManagedDaemonProcess(pid);
				return readManagedDaemonPid(source) === null ? { owners: [] } : { owners: ["daemon"] };
			},
		},
		database: {
			inspect: async () => {
				if (!existsSync(sourceLayout.database)) throw new Error("source database is missing");
				if (!statSync(sourceLayout.database).isFile()) throw new Error("source database is not a regular file");
				const db = createDatabase(sourceLayout.database, { readonly: true });
				try {
					const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
					if (row?.quick_check !== "ok") throw new Error("source database integrity verification failed");
				} finally {
					db.close();
				}
			},
			prepare: async () => {
				if (!existsSync(sourceLayout.database)) throw new Error("source database is missing");
				const db = createDatabase(sourceLayout.database);
				try {
					const checkpoint = db.prepare("PRAGMA wal_checkpoint(TRUNCATE)").get() as { busy?: number } | undefined;
					if (checkpoint?.busy !== 0) throw new Error("database checkpoint is blocked by an active writer");
					const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
					if (row?.integrity_check !== "ok") throw new Error("source database integrity verification failed");
				} finally {
					db.close();
				}
				if (!contained(source, sourceLayout.database)) return undefined;
				const legacyDatabase = join(source, "memory", "memories.db");
				return {
					sourceRoot: dirname(sourceLayout.database),
					sourcePath: sourceLayout.database.split(sep).pop() ?? "memories.db",
					destinationPath:
						resolve(sourceLayout.database) === resolve(legacyDatabase)
							? join("data", "signet.db")
							: relative(source, sourceLayout.database),
					bytes: statSync(sourceLayout.database).size,
				};
			},
			verifySnapshot: async (sourceDatabase, destinationDatabase) => {
				verifyMigrationDatabaseRows(sourceDatabase, destinationDatabase);
			},
		},
		...(rootGitMode === "shell"
			? { gitignoreBytes: (existing: string) => new TextEncoder().encode(mergeSignetGitignoreEntries(existing)) }
			: {}),
		mapDestinationPath,
		layoutBytes: () => serializeWorkspaceLayout({ version: 2, overrides }),
		journalStateDir: state,
	};
	return new MigrationEngine(deps);
}

export function registerMigrationCommands(program: Command, deps: MigrationCommandDeps = {}): void {
	const out = deps.stdout ?? console;
	const factory = deps.createEngine ?? defaultEngine;
	const migration = program.command("migration").description("Manage the v1 to v2 workspace migration");
	const options = (cmd: Command) =>
		cmd.option("--source <path>", "v1 workspace root").option("--destination <path>", "v2 workspace root");

	options(migration.command("preflight").description("Inspect migration without writing")).action(async (opts) => {
		const plan = await factory(opts).preflight();
		out.log(JSON.stringify(plan));
	});
	for (const name of ["run", "resume"] as const) {
		options(
			migration.command(name).description(name === "run" ? "Run the migration" : "Resume an interrupted migration"),
		).action(async (opts) => {
			const result = await factory(opts)[name]();
			out.log(JSON.stringify(result));
		});
	}
	options(migration.command("status").description("Show migration progress and blockers")).action(async (opts) => {
		out.log(JSON.stringify(await factory(opts).status()));
	});
	options(migration.command("rollback").description("Rollback before cutover begins")).action(async (opts) => {
		await factory(opts).rollback();
		out.log(JSON.stringify({ status: "rolled-back" }));
	});
	options(migration.command("cleanup").description("Remove a completed migration journal after acceptance"))
		.option("--accept", "Confirm the destination has been accepted")
		.action(async (opts) => {
			await factory(opts).cleanup(opts.accept === true);
			out.log(JSON.stringify({ status: "cleaned" }));
		});
}
