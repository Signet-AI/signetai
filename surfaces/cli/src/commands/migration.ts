import type { Command } from "commander";
import { createHash, randomUUID } from "node:crypto";
import {
	type BigIntStats,
	chmodSync,
	closeSync,
	existsSync,
	fsyncSync,
	linkSync,
	lstatSync,
	mkdirSync,
	openSync,
	statSync,
	unlinkSync,
} from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { basename, dirname, join, relative, resolve, sep } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { confirm } from "@inquirer/prompts";
import {
	type DescriptorEntry,
	type DescriptorRoot,
	inspectRootGit,
	mergeSignetGitignoreEntries,
	resolveDaemonRuntime,
	resolveWorkspaceLayout,
	serializeWorkspaceLayout,
	spawnHidden as spawn,
} from "@signet/core";
import { MigrationEngine, type MigrationDeps, type Layout } from "../lib/migration-engine.js";
import { closeDatabase, createDatabase, verifyMigrationDatabaseRows } from "../sqlite.js";
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
	confirm?: (message: string) => Promise<boolean>;
	hooks?: MigrationDeps["hooks"];
	stdout?: Pick<Console, "log" | "error">;
};

export function initializeMigrationLeaseFile(leasePath: string): void {
	const stagedPath = `${leasePath}.init-${randomUUID()}`;
	try {
		const staged = createDatabase(stagedPath);
		try {
			staged.exec("PRAGMA user_version = 1");
		} finally {
			closeDatabase(staged);
		}
		chmodSync(stagedPath, 0o600);
		const fd = openSync(stagedPath, "r+");
		try {
			fsyncSync(fd);
		} finally {
			closeSync(fd);
		}
		linkSync(stagedPath, leasePath);
	} catch (error) {
		try {
			unlinkSync(stagedPath);
		} catch {}
		throw error;
	}
	unlinkSync(stagedPath);
}

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
	if (!expectedWorkspace) return ["daemon:workspace-unverified"];
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
	if (typeof expectedPid !== "number" || Reflect.get(identity, "pid") !== expectedPid) return ["daemon:pid-unverified"];
	let response: Response;
	try {
		response = await fetchImpl(`${baseUrl.replace(/\/$/, "")}/api/workspace/migration-control/drain`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ expectedPid, expectedWorkspace }),
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
			...(process.platform === "win32" ? { SIGNET_MIGRATION_VERIFY: "1" } : {}),
		},
		stdio: process.platform === "win32" ? ["ignore", "pipe", "pipe", "ipc"] : ["ignore", "pipe", "pipe"],
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
		if (child.exitCode === null && childPid !== undefined) {
			try {
				if (process.platform === "win32") child.send({ type: "migration-verification-shutdown" });
				else process.kill(-childPid, "SIGTERM");
			} catch {}
		}
		stopped = await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)]);
		if (!stopped) {
			if (childPid !== undefined) {
				try {
					if (process.platform === "win32") await stopManagedDaemonProcess(childPid);
					else process.kill(-childPid, "SIGKILL");
				} catch {}
			}
			stopped = await Promise.race([exited.then(() => true), sleep(5_000).then(() => false)]);
		}
	}
	if (!stopped) throw new Error("destination daemon did not terminate after verification");
	if (verificationError) throw verificationError;
}

type MigrationPathApi = Pick<typeof import("node:path"), "basename" | "dirname" | "join" | "resolve">;

const nativeMigrationPath: MigrationPathApi = { basename, dirname, join, resolve };

export function defaultMigrationDestination(source: string, pathApi: MigrationPathApi = nativeMigrationPath): string {
	return pathApi.resolve(source);
}

function formatMigrationPlan(plan: Awaited<ReturnType<MigrationEngine["preflight"]>>): string {
	const untouched = plan.untouched.length;
	return [
		"In-place Signet workspace upgrade",
		`Workspace: ${plan.source}`,
		`Managed files to migrate: ${plan.components.length}`,
		`Additional disk space: ${plan.bytes} bytes`,
		`Entries left untouched: ${untouched} (contents are not inspected or hashed)`,
		"The workspace path stays the same. The layout marker is updated after staged files are verified.",
	].join("\n");
}

export function migrationLeasePath(
	state: string,
	source: string,
	options: {
		readonly platform?: NodeJS.Platform;
		readonly pathApi?: MigrationPathApi;
		readonly exists?: (path: string) => boolean;
	} = {},
): string {
	const pathApi = options.pathApi ?? nativeMigrationPath;
	const platform = options.platform ?? process.platform;
	const resolvedSource = pathApi.resolve(source);
	const legacyName =
		platform === "win32" ? resolvedSource.replace(/[\\/:]/g, "_") : resolvedSource.replaceAll("/", "_");
	const legacyPath = pathApi.join(state, `${legacyName}.lease`);
	if (platform === "win32") {
		if ((options.exists ?? existsSync)(legacyPath)) return legacyPath;
		const id = createHash("sha256").update(resolvedSource).digest("hex").slice(0, 32);
		return pathApi.join(state, `${id}.lease`);
	}
	return legacyPath;
}

const legacyTranscriptHarnesses = [
	"claude-code",
	"codex",
	"forge",
	"gemini",
	"hermes-agent",
	"kimi",
	"oh-my-pi",
	"openclaw",
	"opencode",
	"pi",
] as const;

async function addRegisteredTree(root: DescriptorRoot, path: string, entries: DescriptorEntry[]): Promise<void> {
	const entry = await root.inspectEntry(path);
	entries.push(entry);
	if (entry.type !== "directory") return;
	const directory = await root.openDirectory(path);
	try {
		for (const child of await directory.inventory()) entries.push({ ...child, path: `${path}/${child.path}` });
	} finally {
		await directory.close();
	}
}

async function selectLegacyMigrationEntries(
	root: DescriptorRoot,
	scope: { readonly runtime: boolean; readonly imports: boolean; readonly transcripts: boolean },
): Promise<{ entries: DescriptorEntry[]; untouched: string[] }> {
	const rootNames = await root.listNames();
	const untouched = rootNames.filter(
		(name) => name !== "memory" && name !== "workspace-layout.json" && !(name === ".daemon" && scope.runtime),
	);
	const entries: DescriptorEntry[] = [];
	if (rootNames.includes(".daemon") && scope.runtime) await addRegisteredTree(root, ".daemon", entries);
	if (!rootNames.includes("memory")) return { entries, untouched: untouched.sort() };

	const memory = await root.openDirectory("memory");
	try {
		const names = await memory.listNames();
		for (const name of names) {
			if (["memories.db", "memories.db-wal", "memories.db-shm"].includes(name)) continue;
			if (name === "imports") {
				if (scope.imports) await addRegisteredTree(root, "memory/imports", entries);
				else untouched.push("memory/imports");
				continue;
			}
			if (name === "cache") {
				untouched.push("memory/cache");
				continue;
			}
			if (/^[^/]+--(?:summary|transcript|compaction|manifest)\.md$/.test(name)) {
				if (!scope.transcripts) {
					untouched.push(`memory/${name}`);
					continue;
				}
				const entry = await root.inspectEntry(`memory/${name}`);
				if (entry.type !== "directory") entries.push(entry);
				else untouched.push(`memory/${name}`);
				continue;
			}
			if (legacyTranscriptHarnesses.some((harness) => harness === name)) {
				if (!scope.transcripts) {
					untouched.push(`memory/${name}`);
					continue;
				}
				const harness = await memory.openDirectory(name);
				try {
					if ((await harness.listNames()).includes("transcripts"))
						await addRegisteredTree(root, `memory/${name}/transcripts`, entries);
					else untouched.push(`memory/${name}`);
				} finally {
					await harness.close();
				}
				continue;
			}
			untouched.push(`memory/${name}`);
		}
	} finally {
		await memory.close();
	}
	return { entries, untouched: [...new Set(untouched)].sort() };
}

export function createDefaultMigrationEngine(
	options: { source?: string; destination?: string },
	hooks?: MigrationDeps["hooks"],
): MigrationEngine {
	const source = resolve(options.source ?? resolveAgentsDir().path);
	const destination = resolve(options.destination ?? defaultMigrationDestination(source));
	const sameDirectory =
		destination === source || (process.platform === "win32" && sameWindowsDirectory(source, destination));
	if (!sameDirectory)
		throw new Error("workspace layout migration upgrades in place; --destination must match --source");
	const sourceLayout = resolveWorkspaceLayout(source);
	const rootGitMode = inspectRootGit(source).mode;
	if (sourceLayout.version !== 1 && sourceLayout.version !== 2)
		throw new Error(`unsupported workspace layout version: ${sourceLayout.version}`);
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
	const migrationScope = {
		runtime: sourceLayout.runtime === legacyDefaults.runtime,
		imports: sourceLayout.imports === legacyDefaults.imports,
		transcripts: sourceLayout.transcripts === legacyDefaults.transcripts,
	} as const;
	const overrides = Object.fromEntries(
		Object.entries(legacyDefaults)
			.filter(([key, value]) => sourceLayout[key as keyof typeof legacyDefaults] !== value)
			.map(([key]) => [
				key,
				key === "database"
					? contained(source, sourceLayout.database)
						? relative(source, sourceLayout.database)
						: sourceLayout.database
					: contained(source, sourceLayout[key as keyof typeof legacyDefaults])
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
	const mapDestinationPath = (path: string, type: "file" | "symlink" | "directory"): string | undefined => {
		if (path === "workspace-layout.json") return undefined;
		if (databasePath && (path === databasePath || path === `${databasePath}-wal` || path === `${databasePath}-shm`))
			return undefined;
		if (customRoots.some((root) => withinDescriptorPath(root, path))) return path;
		if (type === "directory") {
			if (path === ".daemon") return "runtime";
			if (path === "memory") return "data/legacy-memory";
			if (path === "memory/cache") return "cache";
			if (path === "memory/imports") return "data/imports";
			const transcripts = /^memory\/([^/]+)\/transcripts$/.exec(path);
			if (transcripts) return `transcripts/${transcripts[1]}`;
		}
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
		isCutover: async () => resolveWorkspaceLayout(source).version === 2,
		cutover: async () => {
			writeConfiguredWorkspacePath(destination);
		},
		verifyDestination: async () => {
			const layout = resolveWorkspaceLayout(destination);
			if (layout.version !== 2) throw new Error("destination layout verification failed");
			if (!existsSync(layout.database)) throw new Error("destination database is missing");
			if (!lstatSync(layout.database).isFile()) throw new Error("destination database is not a regular file");
			const db = createDatabase(layout.database, { readonly: true });
			try {
				const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
				if (row?.quick_check !== "ok") throw new Error("destination database verification failed");
			} finally {
				closeDatabase(db);
			}
			await verifyDestinationDaemon(destination);
		},
	};
	const leasePath = migrationLeasePath(state, source);
	const acquireLease = async () => {
		mkdirSync(state, { recursive: true, mode: 0o700 });
		try {
			initializeMigrationLeaseFile(leasePath);
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
		}
		if (!lstatSync(leasePath).isFile()) throw new Error("legacy migration lease is not a regular file");
		const db = createDatabase(leasePath);
		try {
			const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
			if (row?.user_version !== 1)
				throw new Error("legacy migration lease cannot be reclaimed without verifying its owner");
			db.exec("PRAGMA busy_timeout = 0");
			db.exec("BEGIN IMMEDIATE");
		} catch (error) {
			closeDatabase(db);
			if ((error as { code?: string }).code === "SQLITE_BUSY")
				throw new Error("another migration is already running", { cause: error });
			throw error;
		}
		return {
			release: async () => {
				try {
					db.exec("ROLLBACK");
				} finally {
					closeDatabase(db);
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
			externalReference: async () => {
				if (contained(source, sourceLayout.database)) return undefined;
				const stat = lstatSync(sourceLayout.database, { bigint: true });
				if (!stat.isFile()) throw new Error("external source database is not a regular file");
				return {
					path: resolve(sourceLayout.database),
					device: String(stat.dev),
					inode: String(stat.ino),
				};
			},
			inspect: async () => {
				if (!existsSync(sourceLayout.database)) throw new Error("source database is missing");
				if (!statSync(sourceLayout.database).isFile()) throw new Error("source database is not a regular file");
				const db = createDatabase(sourceLayout.database, { readonly: true });
				try {
					const row = db.prepare("PRAGMA quick_check").get() as { quick_check?: string } | undefined;
					if (row?.quick_check !== "ok") throw new Error("source database integrity verification failed");
				} finally {
					closeDatabase(db);
				}
			},
			acquireFence: async () => {
				const sourceDatabase = sourceLayout.database;
				let sourceStat: BigIntStats;
				try {
					sourceStat = lstatSync(sourceDatabase, { bigint: true });
				} catch (error) {
					if (error && typeof error === "object" && Reflect.get(error, "code") === "ENOENT")
						throw new Error("source database is missing", { cause: error });
					throw error;
				}
				if (!sourceStat.isFile()) throw new Error("source database is not a regular file");
				const db = createDatabase(sourceDatabase);
				let fencedStat: BigIntStats;
				try {
					db.exec("PRAGMA busy_timeout = 0");
					db.exec("BEGIN IMMEDIATE");
					fencedStat = lstatSync(sourceDatabase, { bigint: true });
					if (!fencedStat.isFile() || fencedStat.dev !== sourceStat.dev || fencedStat.ino !== sourceStat.ino)
						throw new Error("external database identity changed during migration");
				} catch (error) {
					closeDatabase(db);
					if (
						(error instanceof Error && /database is locked/.test(error.message)) ||
						(error && typeof error === "object" && Reflect.get(error, "code") === "SQLITE_BUSY")
					)
						throw new Error("source database has an active writer", { cause: error });
					throw error;
				}
				let released = false;
				return {
					externalDatabase: contained(source, sourceDatabase)
						? null
						: {
								path: resolve(sourceDatabase),
								device: String(fencedStat.dev),
								inode: String(fencedStat.ino),
							},
					release: async () => {
						if (released) return;
						released = true;
						try {
							db.exec("ROLLBACK");
						} finally {
							closeDatabase(db);
						}
					},
				};
			},
			prepare: async () => {
				if (!existsSync(sourceLayout.database)) throw new Error("source database is missing");
				const externalDatabase = !contained(source, sourceLayout.database);
				if (externalDatabase) {
					const external = createDatabase(sourceLayout.database, { readonly: true });
					try {
						const row = external.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
						if (row?.integrity_check !== "ok") throw new Error("source database integrity verification failed");
					} finally {
						closeDatabase(external);
					}
					return undefined;
				}
				const db = createDatabase(sourceLayout.database, { readonly: true });
				try {
					const row = db.prepare("PRAGMA integrity_check").get() as { integrity_check?: string } | undefined;
					if (row?.integrity_check !== "ok") throw new Error("source database integrity verification failed");
				} finally {
					closeDatabase(db);
				}
				if (!contained(source, sourceLayout.database)) return undefined;
				const legacyDatabase = join(source, "memory", "memories.db");
				if (resolve(sourceLayout.database) !== resolve(legacyDatabase)) return undefined;
				return {
					sourceRoot: dirname(sourceLayout.database),
					sourcePath: sourceLayout.database.split(sep).pop() ?? "memories.db",
					destinationPath: join("data", "signet.db"),
					bytes: statSync(sourceLayout.database).size,
				};
			},
			backupTo: async (stagedSource, stagedDestination) => {
				const escaped = stagedDestination.replaceAll("'", "''");
				const db = createDatabase(stagedSource, { readonly: true });
				try {
					db.exec(`VACUUM INTO '${escaped}'`);
				} finally {
					closeDatabase(db);
				}
			},
			verifySnapshot: async (sourceDatabase, destinationDatabase) => {
				verifyMigrationDatabaseRows(sourceDatabase, destinationDatabase);
			},
		},
		...(rootGitMode === "shell"
			? { gitignoreBytes: (existing: string) => new TextEncoder().encode(mergeSignetGitignoreEntries(existing)) }
			: {}),
		mapDestinationPath,
		selectSourceEntries: (root) => selectLegacyMigrationEntries(root, migrationScope),
		layoutBytes: () => serializeWorkspaceLayout({ version: 2, overrides }),
		journalStateDir: state,
		...(hooks ? { hooks } : {}),
	};
	return new MigrationEngine(deps);
}

function sameWindowsDirectory(source: string, destination: string): boolean {
	try {
		const sourceStat = statSync(source, { bigint: true });
		const destinationStat = statSync(destination, { bigint: true });
		return (
			sourceStat.isDirectory() &&
			destinationStat.isDirectory() &&
			sourceStat.dev === destinationStat.dev &&
			sourceStat.ino === destinationStat.ino
		);
	} catch {
		return false;
	}
}

export function registerMigrationCommands(
	program: Command,
	deps: MigrationCommandDeps = {},
	commandName = "migration",
): void {
	const out = deps.stdout ?? console;
	const factory =
		deps.createEngine ??
		((options: { source?: string; destination?: string }) => createDefaultMigrationEngine(options, deps.hooks));
	const description =
		commandName === "migration"
			? "Compatibility alias for workspace layout migration"
			: "Manage the v1 to v2 workspace migration";
	const migration = program.command(commandName).description(description);
	const options = (cmd: Command) =>
		cmd
			.option("--source <path>", "Workspace root to upgrade in place")
			.option("--destination <path>", "Deprecated; must match --source because migration is in place");
	const sourceRoot = (opts: { readonly source?: string }) => resolve(opts.source ?? resolveAgentsDir().path);
	const requireLegacyWorkspace = (opts: { readonly source?: string }): void => {
		const root = sourceRoot(opts);
		if (resolveWorkspaceLayout(root).version !== 1) throw new Error("workspace is not a v1 layout");
	};

	options(migration.command("preflight").description("Inspect migration without writing")).action(async (opts) => {
		requireLegacyWorkspace(opts);
		const plan = await factory(opts).preflight();
		out.log(JSON.stringify(plan));
	});
	options(migration.command("run").description("Upgrade this workspace in place"))
		.option("--dry-run", "Show the upgrade plan without making changes")
		.option("-y, --yes", "Apply the upgrade without an interactive confirmation")
		.action(async (opts) => {
			if (opts.dryRun && opts.yes) throw new Error("--dry-run and --yes cannot be used together");
			requireLegacyWorkspace(opts);
			const engine = factory(opts);
			const plan = await engine.preflight();
			out.log(formatMigrationPlan(plan));
			if (opts.dryRun) return;
			if (!opts.yes) {
				const ask =
					deps.confirm ??
					(async (message: string) => {
						if (!process.stdin.isTTY || !process.stdout.isTTY)
							throw new Error("interactive confirmation required; rerun with --yes to apply");
						return await confirm({ message, default: false });
					});
				if (!(await ask("Apply this in-place workspace upgrade?"))) {
					out.log("Migration cancelled; no changes made.");
					return;
				}
			}
			out.log(JSON.stringify(await engine.run(plan)));
		});

	options(migration.command("resume").description("Resume an interrupted in-place upgrade")).action(async (opts) => {
		const engine = factory(opts);
		if (resolveWorkspaceLayout(sourceRoot(opts)).version === 2) {
			const status = await engine.status();
			if (status.phase !== "cutover-pending" && status.phase !== "completed")
				throw new Error("v2 workspace has no resumable migration journal");
		}
		out.log(JSON.stringify(await engine.resume()));
	});
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
