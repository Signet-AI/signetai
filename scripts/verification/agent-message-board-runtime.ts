import { Database } from "bun:sqlite";
import { createHash, randomBytes } from "node:crypto";
import {
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	readlinkSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { homedir, release, arch } from "node:os";
import { join, resolve } from "node:path";
import { createToken, loadOrCreateSecret } from "../../platform/daemon/src/auth/tokens";

const PINNED_SHA = "fd288111060baf636aa064d3d201f33b1120ddb5";
const BASE_SHA = "309be2adbc23964c13deaf45b3b33e45a1750f04";
const REPO = resolve(import.meta.dir, "..", "..");
const OUT_DIR = resolve(argValue("--out") ?? join(REPO, "docs", "proofs", "agent-message-board", "runtime"));
const KEEP = process.argv.includes("--keep-workspace");
const SKIP_MUTATION = process.argv.includes("--skip-mutation");
const ONLY_MUTATION = argValue("--only-mutation");
const WATCHDOG_MS = 14 * 60_000;
const HARNESS = "claude-code";
const STARTED_AT = new Date().toISOString();

function argValue(name: string): string | undefined {
	const index = process.argv.indexOf(name);
	return index >= 0 ? process.argv[index + 1] : undefined;
}

interface Check {
	name: string;
	pass: boolean;
	observed: unknown;
}
interface StepRecord {
	id: string;
	title: string;
	status: "pass" | "fail" | "observation" | "not_verified";
	checks: Check[];
	observations: Record<string, unknown>;
	ms: number;
}
interface StepCtx {
	check(name: string, pass: unknown, observed?: unknown): boolean;
	obs(key: string, value: unknown): void;
}

const steps: StepRecord[] = [];
const scratchRoots: string[] = [];
const liveDaemons = new Set<Daemon>();
const redactions: Array<[string, string]> = [];

function redact(text: string): string {
	let out = text;
	for (const [from, to] of [...redactions].sort((a, b) => b[0].length - a[0].length))
		if (from) out = out.split(from).join(to);
	return out;
}

function sortKeys(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(sortKeys);
	if (value && typeof value === "object") {
		const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
		return Object.fromEntries(entries.map(([key, val]) => [key, sortKeys(val)]));
	}
	return value;
}

async function step(
	id: string,
	title: string,
	body: (ctx: StepCtx) => Promise<void>,
	kind: "pass" | "observation" = "pass",
): Promise<StepRecord> {
	const started = Date.now();
	const record: StepRecord = { id, title, status: "pass", checks: [], observations: {}, ms: 0 };
	const ctx: StepCtx = {
		check(name, passed, observed) {
			const pass = passed === true;
			record.checks.push({ name, pass, observed: observed === undefined ? null : observed });
			if (!pass) console.error(`  FAIL ${id}: ${name} observed=${JSON.stringify(observed)?.slice(0, 400)}`);
			return pass;
		},
		obs(key, value) {
			record.observations[key] = value;
		},
	};
	try {
		await body(ctx);
	} catch (error) {
		ctx.check("step completed without exception", false, error instanceof Error ? error.message : String(error));
	}
	record.ms = Date.now() - started;
	const failed = record.checks.some((c) => !c.pass);
	record.status = failed ? "fail" : kind === "observation" ? "observation" : "pass";
	steps.push(record);
	console.error(`${failed ? "FAIL" : "ok  "} ${id} ${title} (${record.ms}ms, ${record.checks.length} checks)`);
	return record;
}

function notVerified(id: string, title: string, reason: string): void {
	steps.push({ id, title, status: "not_verified", checks: [], observations: { reason }, ms: 0 });
	console.error(`NOT VERIFIED ${id} ${title}: ${reason}`);
}

function sleep(ms: number): Promise<void> {
	return new Promise((done) => setTimeout(done, ms));
}

function git(args: string[]): string {
	const result = Bun.spawnSync(["git", ...args], { cwd: REPO });
	return result.stdout.toString().trim();
}

function ps(): Array<{ pid: number; ppid: number; pgid: number; args: string }> {
	const result = Bun.spawnSync(["ps", "-eo", "pid=,ppid=,pgid=,args="]);
	return result.stdout
		.toString()
		.split("\n")
		.map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(\d+)\s+(.*)$/))
		.filter((m): m is RegExpMatchArray => m !== null)
		.map((m) => ({ pid: Number(m[1]), ppid: Number(m[2]), pgid: Number(m[3]), args: m[4] ?? "" }));
}

function descendants(root: number): Array<{ pid: number; ppid: number; pgid: number; args: string }> {
	const all = ps();
	const found = new Map<number, (typeof all)[number]>();
	const queue = [root];
	while (queue.length > 0) {
		const parent = queue.pop() as number;
		for (const proc of all) {
			if (proc.ppid === parent && !found.has(proc.pid)) {
				found.set(proc.pid, proc);
				queue.push(proc.pid);
			}
		}
	}
	return [...found.values()];
}

function pidAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function envOwners(marker: string): number[] {
	const owners: number[] = [];
	for (const entry of readdirSync("/proc")) {
		if (!/^\d+$/.test(entry) || Number(entry) === process.pid) continue;
		try {
			const environ = readFileSync(`/proc/${entry}/environ`, "utf8");
			if (environ.includes(marker)) owners.push(Number(entry));
		} catch {}
	}
	return owners;
}

function openDbFds(pid: number): string[] {
	const paths: string[] = [];
	try {
		for (const fd of readdirSync(`/proc/${pid}/fd`)) {
			try {
				const target = readlinkSync(`/proc/${pid}/fd/${fd}`);
				if (/(memories|signet)\.db$/.test(target)) paths.push(target);
			} catch {}
		}
	} catch {
		return paths;
	}
	return paths;
}

async function freePort(): Promise<number> {
	const server = Bun.listen({ hostname: "127.0.0.1", port: 0, socket: { data() {} } });
	const port = server.port;
	server.stop(true);
	await sleep(50);
	return port;
}

interface Daemon {
	pid: number;
	pgid: number;
	port: number;
	base: string;
	ws: string;
	logPath: string;
	exited: Promise<number | null>;
	proc: ReturnType<typeof Bun.spawn>;
}

interface Workspace {
	root: string;
	ws: string;
	home: string;
	tmp: string;
	port: number;
}

function scratchBase(): string {
	return join(homedir(), ".hermes", "cache", "scratch");
}

function makeWorkspace(label: string, authMode: "local" | "team", port: number): Workspace {
	const root = join(scratchBase(), `signet-pr2181-${label}-${randomBytes(4).toString("hex")}`);
	const ws = join(root, "ws");
	const home = join(root, "home");
	const tmp = join(root, "tmp");
	mkdirSync(join(ws, "memory"), { recursive: true });
	mkdirSync(home, { recursive: true });
	mkdirSync(tmp, { recursive: true });
	scratchRoots.push(root);
	const authBlock = authMode === "team" ? "auth:\n  mode: team\n" : "";
	writeFileSync(
		join(ws, "agent.yaml"),
		[
			"configVersion: 9",
			"version: 1",
			"schema: signet/v1",
			`name: PR2181 proof ${label}`,
			"network:",
			"  mode: localhost",
			"memory:",
			"  database: memory/memories.db",
			"  pipelineV2:",
			"    enabled: false",
			"    paused: true",
			"  dreaming:",
			"    enabled: false",
			"embedding:",
			"  provider: none",
			authBlock,
		].join("\n"),
	);
	redactions.push([root, "<SCRATCH>"], [homedir(), "<HOME>"], [REPO, "<WORKTREE>"]);
	return { root, ws, home, tmp, port };
}

function initDb(wsInfo: Workspace, daemonDir: string): void {
	const script = [
		`import { initDbAccessor } from ${JSON.stringify(join(daemonDir, "src", "db-accessor"))};`,
		`initDbAccessor(${JSON.stringify(join(wsInfo.ws, "memory", "memories.db"))});`,
		"process.exit(0);",
	].join("\n");
	const file = join(wsInfo.tmp, "init-db.ts");
	writeFileSync(file, script);
	const result = Bun.spawnSync([process.execPath, file], {
		cwd: daemonDir,
		env: daemonEnv(wsInfo),
		timeout: 90_000,
	});
	if (result.exitCode !== 0) throw new Error(`db init failed: ${redact(result.stderr.toString()).slice(0, 500)}`);
}

function daemonEnv(wsInfo: Workspace): Record<string, string> {
	return {
		PATH: process.env.PATH ?? "/usr/bin:/bin",
		HOME: wsInfo.home,
		TMPDIR: wsInfo.tmp,
		LANG: "C.UTF-8",
		SIGNET_PATH: wsInfo.ws,
		SIGNET_PORT: String(wsInfo.port),
		SIGNET_HOST: "127.0.0.1",
		SIGNET_TELEMETRY_OPTOUT: "1",
		NO_COLOR: "1",
	};
}

async function startDaemon(wsInfo: Workspace, daemonDir: string, tag: string): Promise<Daemon> {
	const listening = Bun.spawnSync(["ss", "-tln", `sport = :${wsInfo.port}`]).stdout.toString();
	if (listening.includes(`:${wsInfo.port}`)) throw new Error(`port ${wsInfo.port} is already bound`);
	const logPath = join(wsInfo.root, `daemon-${tag}.log`);
	const proc = Bun.spawn(["setsid", process.execPath, "src/daemon.ts"], {
		cwd: daemonDir,
		env: daemonEnv(wsInfo),
		stdout: Bun.file(logPath),
		stderr: Bun.file(logPath),
		stdin: "ignore",
	});
	const daemon: Daemon = {
		pid: proc.pid,
		pgid: proc.pid,
		port: wsInfo.port,
		base: `http://127.0.0.1:${wsInfo.port}`,
		ws: wsInfo.ws,
		logPath,
		exited: proc.exited.then((code) => code),
		proc,
	};
	liveDaemons.add(daemon);
	const deadline = Date.now() + 90_000;
	let exited = false;
	void daemon.exited.then(() => {
		exited = true;
	});
	while (Date.now() < deadline) {
		if (exited) throw new Error(`daemon exited during boot: ${redact(tailLog(logPath, 1500))}`);
		try {
			const res = await fetch(`${daemon.base}/health`, { signal: AbortSignal.timeout(1500) });
			if (res.ok) {
				const health = (await res.json()) as Record<string, unknown>;
				const dir = String(health.agentsDir ?? health.agents_dir ?? "");
				if (dir !== wsInfo.ws) throw new Error(`health agentsDir mismatch: ${redact(dir)}`);
				return daemon;
			}
		} catch (error) {
			if (error instanceof Error && error.message.startsWith("health agentsDir")) throw error;
		}
		await sleep(250);
	}
	throw new Error(`daemon not healthy within 90s: ${redact(tailLog(logPath, 1500))}`);
}

function tailLog(path: string, chars: number): string {
	try {
		return readFileSync(path, "utf8").slice(-chars);
	} catch {
		return "";
	}
}

async function stopDaemon(
	daemon: Daemon,
	mode: "graceful" | "kill9",
): Promise<{ mode: string; ms: number; survivors: number[] }> {
	const started = Date.now();
	const signal = mode === "kill9" ? "SIGKILL" : "SIGTERM";
	try {
		process.kill(-daemon.pgid, signal);
	} catch {
		void 0;
	}
	const deadline = Date.now() + (mode === "kill9" ? 5_000 : 25_000);
	while (Date.now() < deadline && pidAlive(daemon.pid)) await sleep(100);
	if (pidAlive(daemon.pid) || ps().some((p) => p.pgid === daemon.pgid)) {
		try {
			process.kill(-daemon.pgid, "SIGKILL");
		} catch {
			void 0;
		}
		await sleep(500);
	}
	await Promise.race([daemon.exited, sleep(2_000)]);
	const survivors = envOwners(daemon.ws);
	for (const pid of survivors) {
		try {
			process.kill(pid, "SIGKILL");
		} catch {
			void 0;
		}
	}
	liveDaemons.delete(daemon);
	const deadlinePort = Date.now() + 8_000;
	while (Date.now() < deadlinePort) {
		const listening = Bun.spawnSync(["ss", "-tln", `sport = :${daemon.port}`]).stdout.toString();
		if (!listening.includes(`:${daemon.port}`)) break;
		await sleep(200);
	}
	return { mode, ms: Date.now() - started, survivors };
}

async function cleanupAll(): Promise<void> {
	for (const daemon of [...liveDaemons]) await stopDaemon(daemon, "graceful").catch(() => undefined);
	if (!KEEP) {
		for (const root of scratchRoots) {
			for (const pid of envOwners(root)) {
				try {
					process.kill(pid, "SIGKILL");
				} catch {
					void 0;
				}
			}
			try {
				rmSync(root, { recursive: true, force: true });
			} catch {
				void 0;
			}
		}
	}
}

interface Entity {
	id?: string;
	slug?: string;
	sessionKey?: string;
	agentId?: string;
	authorAgentId?: string;
	threadId?: string;
	threadCount?: number;
	threads?: number;
	pinned?: boolean;
	status?: string;
	[key: string]: unknown;
}

interface Payload {
	_raw?: string;
	wake?: boolean;
	messageIds?: string[];
	message?: Entity;
	thread?: Entity;
	post?: Entity;
	posts?: Entity[];
	sessions?: Entity[];
	items?: Entity[];
	topics?: Entity[];
	presence?: Entity;
	notifications?: { boardNotices?: Entity[] } & Record<string, unknown>;
	reason?: string;
	released?: unknown;
	readThroughPostId?: string | null;
	lastReadPostId?: string | null;
	hasMorePosts?: boolean;
	postTotal?: number;
	total?: number;
	retryAfterMs?: number;
	[key: string]: unknown;
}

type SqlValue = string | number | null;
type Row = Record<string, SqlValue | undefined>;

interface SseEvent {
	event?: string;
	data?: unknown;
	[key: string]: unknown;
}

interface BoardIds {
	threadId: string;
	postIds: string[];
	otherThreadId: string;
	carolThreadId?: string;
	livePost?: string;
}

interface Pre {
	pendingId?: string;
	pendingWaked?: number;
	migration?: Row;
	otherThread?: Payload | null;
	bobCursor?: unknown;
	counts?: Record<string, number>;
	presenceBob?: unknown;
	health?: unknown;
}

const shared: {
	board?: BoardIds;
	tokens?: Record<string, string>;
	teamHolder?: { daemon: Daemon };
} = {};

interface Api {
	status: number;
	json: Payload | null;
	ms: number;
}

class Client {
	constructor(
		private readonly getBase: () => string,
		private readonly token?: string,
	) {}
	async call(
		method: string,
		path: string,
		body?: unknown,
		extraHeaders: Record<string, string> = {},
		timeoutMs = 40_000,
	): Promise<Api> {
		const started = Date.now();
		const headers: Record<string, string> = { ...extraHeaders };
		if (body !== undefined) headers["content-type"] = "application/json";
		if (this.token) headers.authorization = `Bearer ${this.token}`;
		const res = await fetch(`${this.getBase()}${path}`, {
			method,
			headers,
			body: body === undefined ? undefined : JSON.stringify(body),
			signal: AbortSignal.timeout(timeoutMs),
		});
		const text = await res.text();
		let json: Payload | null = null;
		try {
			json = text ? (JSON.parse(text) as Payload | null) : null;
		} catch {
			json = { _raw: text.slice(0, 300) };
		}
		return { status: res.status, json, ms: Date.now() - started };
	}
	get(path: string, headers?: Record<string, string>) {
		return this.call("GET", path, undefined, headers);
	}
	post(path: string, body?: unknown) {
		return this.call("POST", path, body ?? {});
	}
	patch(path: string, body: unknown) {
		return this.call("PATCH", path, body);
	}
	del(path: string) {
		return this.call("DELETE", path);
	}
	wake(agentId: string, sessionKey: string, waitMs: number, signal?: AbortSignal): Promise<Api> {
		const started = Date.now();
		const headers: Record<string, string> = { "content-type": "application/json" };
		if (this.token) headers.authorization = `Bearer ${this.token}`;
		return fetch(`${this.getBase()}/api/cross-agent/wake`, {
			method: "POST",
			headers,
			body: JSON.stringify({ harness: HARNESS, sessionKey, agentId, waitMs }),
			signal: signal ?? AbortSignal.timeout(waitMs + 20_000),
		}).then(async (res) => ({
			status: res.status,
			json: (await res.json().catch(() => null)) as Payload | null,
			ms: Date.now() - started,
		}));
	}
	async sse(path: string): Promise<{ events: SseEvent[]; close(): void; ready: Promise<void> }> {
		const events: SseEvent[] = [];
		const controller = new AbortController();
		const headers: Record<string, string> = {};
		if (this.token) headers.authorization = `Bearer ${this.token}`;
		const res = await fetch(`${this.getBase()}${path}`, { headers, signal: controller.signal });
		const reader = res.body?.getReader();
		const decoder = new TextDecoder();
		let buffer = "";
		let readyResolve: () => void = () => undefined;
		const ready = new Promise<void>((done) => {
			readyResolve = done;
		});
		void (async () => {
			try {
				while (reader) {
					const { value, done } = await reader.read();
					if (done) break;
					buffer += decoder.decode(value, { stream: true });
					readyResolve();
					let index = buffer.indexOf("\n\n");
					while (index >= 0) {
						const frame = buffer.slice(0, index);
						buffer = buffer.slice(index + 2);
						const data = frame
							.split("\n")
							.filter((line) => line.startsWith("data:"))
							.map((line) => line.slice(5).trim())
							.join("");
						const eventName = frame
							.split("\n")
							.find((line) => line.startsWith("event:"))
							?.slice(6)
							.trim();
						if (data) {
							try {
								events.push({ event: eventName, ...(JSON.parse(data) as object) });
							} catch {
								events.push({ event: eventName, raw: data.slice(0, 200) });
							}
						}
						index = buffer.indexOf("\n\n");
					}
				}
			} catch {
				void 0;
			}
		})();
		return {
			events,
			ready,
			close() {
				controller.abort();
			},
		};
	}
}

const snapshotStats = { taken: 0, frozen_ms: [] as number[], unsafe: 0 };

function procState(pid: number): string {
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
		return stat.slice(stat.lastIndexOf(")") + 2, stat.lastIndexOf(")") + 3);
	} catch {
		return "gone";
	}
}

function groupMembers(daemon: Daemon): number[] {
	const members = new Set<number>([daemon.pid, ...descendants(daemon.pid).map((p) => p.pid)]);
	for (const proc of ps()) if (proc.pgid === daemon.pgid) members.add(proc.pid);
	members.delete(process.pid);
	return [...members];
}

function snapshotDbPath(ws: string): string {
	for (const candidate of [join(ws, "memory", "memories.db"), join(ws, "data", "signet.db")])
		if (existsSync(candidate)) return candidate;
	throw new Error("no workspace database file found");
}

function withSnapshot<T>(ws: string, use: (snapshotDb: string) => T): T {
	const source = snapshotDbPath(ws);
	const owner = [...liveDaemons].find((d) => d.ws === ws && pidAlive(d.pid));
	const dir = mkdtempSync(join(scratchBase(), "signet-pr2181-snap-"));
	scratchRoots.push(dir);
	const stopped: number[] = [];
	const frozenAt = Date.now();
	try {
		if (owner) {
			const members = groupMembers(owner);
			for (const pid of members) {
				try {
					process.kill(pid, "SIGSTOP");
					stopped.push(pid);
				} catch {}
			}
			const deadline = Date.now() + 3_000;
			while (Date.now() < deadline && stopped.some((pid) => !["T", "t", "gone", "Z"].includes(procState(pid))))
				Bun.sleepSync(10);
			const running = stopped.filter((pid) => !["T", "t", "gone", "Z"].includes(procState(pid)));
			if (running.length > 0) throw new Error(`could not freeze db owner group; still running: ${running.join(",")}`);
		}
		const holders = readdirSync("/proc")
			.filter((e) => /^\d+$/.test(e) && Number(e) !== process.pid)
			.map(Number)
			.filter((pid) => openDbFds(pid).some((t) => t.startsWith(source)));
		const outside = holders.filter((pid) => !stopped.includes(pid));
		if (outside.length > 0) throw new Error(`db fd holders outside the frozen group: ${outside.join(",")}`);
		const target = join(dir, "snapshot.db");
		for (const suffix of ["", "-wal", "-shm"]) {
			const file = `${source}${suffix}`;
			if (existsSync(file)) writeFileSync(`${target}${suffix}`, readFileSync(file));
		}
		for (const pid of stopped) {
			try {
				process.kill(pid, "SIGCONT");
			} catch {}
		}
		snapshotStats.frozen_ms.push(Date.now() - frozenAt);
		stopped.length = 0;
		snapshotStats.taken += 1;
		return use(target);
	} catch (error) {
		snapshotStats.unsafe += 1;
		throw error;
	} finally {
		for (const pid of stopped) {
			try {
				process.kill(pid, "SIGCONT");
			} catch {}
		}
		rmSync(dir, { recursive: true, force: true });
	}
}

function has(list: string[] | undefined, id: unknown): boolean {
	return typeof id === "string" && list?.includes(id) === true;
}

function must<T>(value: T | null | undefined, what: string): T {
	if (value === null || value === undefined) throw new Error(`missing ${what}`);
	return value;
}

function sql<T = Row>(ws: string, query: string, ...params: Array<SqlValue | undefined>): T[] {
	if (params.some((p) => p === undefined)) throw new Error(`sql parameter undefined: ${query.slice(0, 80)}`);
	return withSnapshot(ws, (file) => {
		const db = new Database(file);
		try {
			return db.query(query).all(...(params as SqlValue[])) as T[];
		} finally {
			db.close();
		}
	});
}

function count(ws: string, table: string, where = "1=1", ...params: Array<SqlValue | undefined>): number {
	return sql<{ n: number }>(ws, `SELECT COUNT(*) AS n FROM ${table} WHERE ${where}`, ...params)[0]?.n ?? -1;
}

const HOOK_PROJECT = "proof-project";

async function presence(api: Client, agentId: string, sessionKey: string) {
	return await api.post("/api/cross-agent/presence", { harness: HARNESS, sessionKey, agentId, project: HOOK_PROJECT });
}

async function send(api: Client, from: [string, string], to: [string, string], content: string) {
	return await api.post("/api/cross-agent/messages", {
		content,
		fromAgentId: from[0],
		fromSessionKey: from[1],
		toSessionKey: to[1],
		type: "info",
	});
}

async function boot(wsInfo: Workspace, daemonDir: string, tag: string, ctx: StepCtx): Promise<Daemon> {
	const daemon = await startDaemon(wsInfo, daemonDir, tag);
	const health = (await (await fetch(`${daemon.base}/health`)).json()) as Record<string, unknown>;
	ctx.check(
		"health agentsDir equals scratch workspace",
		String(health.agentsDir ?? "") === wsInfo.ws,
		redact(String(health.agentsDir)),
	);
	ctx.check("daemon bound only to dynamic loopback port", wsInfo.port !== 3850 && wsInfo.port > 1024, wsInfo.port);
	const listening = Bun.spawnSync(["ss", "-tlnp", `sport = :${wsInfo.port}`]).stdout.toString();
	ctx.check(
		"listener is 127.0.0.1 only",
		listening.includes(`127.0.0.1:${wsInfo.port}`) &&
			!listening.includes(`0.0.0.0:${wsInfo.port}`) &&
			!listening.includes(`*:${wsInfo.port}`),
		redact(listening.trim()),
	);
	ctx.obs(`health_${tag}`, {
		pid_is_daemon_tree: daemon.pid,
		health_pid: health.pid,
		version: health.version,
		status: health.status,
	});
	return daemon;
}

interface MutationSpec {
	id: string;
	file: string;
	find: string;
	replace: string;
	scenario: "ack" | "release" | "snapshot";
	expect: string[];
}

const MUTATIONS: MutationSpec[] = [
	{
		id: "M1-ack-ignored-by-wake-claim",
		file: "platform/daemon/src/cross-agent-wake.ts",
		find: "\t  AND r.acknowledged_at IS NULL\n",
		replace: "",
		scenario: "ack",
		expect: ["acknowledged DM is not redispatched even with claim released"],
	},
	{
		id: "M2-release-is-noop",
		file: "platform/daemon/src/cross-agent-wake.ts",
		find: '"DELETE FROM cross_agent_message_wakes WHERE message_id = ? AND agent_id = ? AND session_key = ?"',
		replace:
			'"DELETE FROM cross_agent_message_wakes WHERE message_id = ? AND agent_id = ? AND session_key = ? AND 1 = 0"',
		scenario: "release",
		expect: [
			"refusal release deletes exactly one claim",
			"claim row gone from DB",
			"after release the same DM wakes again",
		],
	},
	{
		id: "M3-read-cursor-ignores-snapshot",
		file: "platform/daemon/src/board.ts",
		find: "if (input.throughPostId !== undefined) {\n\t\tif (typeof input.throughPostId",
		replace: "if (false as boolean && input.throughPostId !== undefined) {\n\t\tif (typeof input.throughPostId",
		scenario: "snapshot",
		expect: [
			"mark-read with page snapshot stores the snapshot post, not the newer head",
			"DB board_reads.last_read_post_seq equals seq of snapshot post",
		],
	},
];

async function localScenario(
	phase: "full" | "ack" | "release" | "snapshot",
	wsInfo: Workspace,
	daemonHolder: { daemon: Daemon },
	suffix = "",
): Promise<void> {
	const api = new Client(() => daemonHolder.daemon.base);
	const ws = wsInfo.ws;
	const full = phase === "full";
	const id = (name: string) => `${name}${suffix}`;
	const A: [string, string] = ["alice", "proof-alice-1"];
	const B: [string, string] = ["bob", "proof-bob-1"];
	const C: [string, string] = ["carol", "proof-carol-1"];

	await step(
		id("L01-agents-and-presence"),
		"Create agents (shared/isolated read policy) and session presence through HTTP",
		async (s) => {
			for (const [name, policy] of [
				["alice", "shared"],
				["bob", "shared"],
				["carol", "isolated"],
			] as const) {
				const res = await api.post("/api/agents", { name, read_policy: policy });
				s.check(`create agent ${name}`, res.status === 201 && res.json?.read_policy === policy, {
					status: res.status,
					read_policy: res.json?.read_policy,
				});
			}
			for (const [agent, key] of [A, B, C, ["bob", "proof-bob-2"]] as const) {
				const res = await presence(api, agent, key);
				s.check(`presence registered ${key}`, res.status === 200 && res.json?.presence?.sessionKey === key, {
					status: res.status,
					agent: res.json?.presence?.agentId,
				});
			}
			const list = await api.get("/api/cross-agent/presence?agent_id=alice&include_self=true&limit=50");
			const keys = (list.json?.sessions ?? []).map((x: Entity) => x.sessionKey).sort();
			s.obs("presence_listing_from_alice", keys);
			s.check(
				"presence listing is HTTP-visible and includes the registered sessions",
				["proof-bob-1", "proof-carol-1", "proof-alice-1"].every((k) => keys.includes(k)),
				keys,
			);
			const temp = await presence(api, "bob", "proof-temp");
			const removed = await api.del("/api/cross-agent/presence/proof-temp");
			const after =
				(await api.get("/api/cross-agent/presence?agent_id=alice&include_self=true&limit=50")).json?.sessions?.map(
					(x: Entity) => x.sessionKey,
				) ?? [];
			s.check(
				"presence lifecycle: register then delete removes the row",
				temp.status === 200 && removed.json?.removed === true && !after.includes("proof-temp"),
				{ removed: removed.json, still_listed: after.includes("proof-temp") },
			);
		},
	);

	if (full) {
		await step(
			id("L02-database-owner-process-boundary"),
			"Observed DB fd holders in the daemon tree; migration 171 persisted (snapshot SQL)",
			async (s) => {
				const d = daemonHolder.daemon;
				const tree = descendants(d.pid);
				const holders = [d.pid, ...tree.map((t) => t.pid)]
					.map((pid) => ({ pid, dbFds: openDbFds(pid) }))
					.filter((x) => x.dbFds.length > 0);
				s.obs(
					"process_tree",
					tree.map((t) => ({ pid: t.pid, ppid: t.ppid, args: redact(t.args).slice(0, 140) })),
				);
				s.obs(
					"db_fd_holders",
					holders.map((h) => ({ pid: h.pid, is_daemon: h.pid === d.pid, db: h.dbFds.map((p) => redact(p)) })),
				);
				s.obs(
					"single_owner_disclaimer",
					"This is an observation of /proc fd holders at one instant. It does not prove exactly one DB writer or a correct owner architecture, and does not show any ownership problem is fixed.",
				);
				s.check(
					"observed at least one daemon-tree process with the workspace DB fd (observation only, not single-owner proof)",
					holders.length > 0,
					holders.length,
				);
				const migrations = sql<{ version: number }>(ws, "SELECT version FROM schema_migrations WHERE version = 171");
				s.check("schema_migrations contains 171", migrations.length === 1, migrations);
				const tables = sql<{ name: string }>(
					ws,
					"SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE 'board_%' OR name LIKE 'cross_agent_message%') ORDER BY name",
				).map((x) => x.name);
				s.obs("tables", tables);
				s.check(
					"board and wake tables exist",
					["board_posts", "board_reads", "board_threads", "board_topics", "cross_agent_message_wakes"].every((t) =>
						tables.includes(t),
					),
					tables,
				);
			},
		);
	}

	if (full) {
		await step(
			id("L03-dm-longpoll-wake"),
			"DM wakes a real in-flight long-poll; timeout/other-session controls",
			async (s) => {
				const control = await api.wake("bob", "proof-bob-1", 1500);
				s.check(
					"control: no pending DM -> wake=false reason=timeout after ~waitMs",
					control.json?.wake === false && control.json?.reason === "timeout" && control.ms >= 1300,
					{ json: control.json, ms: control.ms },
				);
				const t0 = Date.now();
				const waiting = api.wake("bob", "proof-bob-1", 15_000);
				let resolvedEarly = false;
				void waiting.then(() => {
					resolvedEarly = Date.now() - t0 < 600;
				});
				await sleep(700);
				s.check("long-poll still pending before any DM is sent", !resolvedEarly, { elapsed: Date.now() - t0 });
				const sendRes = await send(api, A, B, "proof-dm-1: wake the waiting session");
				const msgId = sendRes.json?.message?.id;
				s.check("DM accepted over HTTP with id", sendRes.status === 200 && typeof msgId === "string", {
					status: sendRes.status,
					id: msgId,
				});
				const woke = await waiting;
				s.check(
					"waiting session woke with wake=true and the DM id",
					woke.status === 200 && woke.json?.wake === true && has(woke.json?.messageIds, msgId),
					{ status: woke.status, wake: woke.json?.wake, ids: woke.json?.messageIds },
				);
				s.check("wake resolved promptly after send, not at timeout", woke.ms < 5_000 && woke.ms >= 600, {
					ms: woke.ms,
				});
				s.check(
					"inject text carries the DM body",
					String(woke.json?.inject ?? "").includes("proof-dm-1"),
					String(woke.json?.inject ?? "").slice(0, 200),
				);
				const row = sql<Row>(
					ws,
					"SELECT agent_id, session_key, harness FROM cross_agent_message_wakes WHERE message_id = ?",
					msgId,
				);
				s.check(
					"wake claim row persisted by DB owner for bob/proof-bob-1",
					row.length === 1 && row[0]?.agent_id === "bob" && row[0]?.session_key === "proof-bob-1",
					row,
				);
				const again = await api.wake("bob", "proof-bob-1", 1500);
				s.check(
					"no redispatch: claimed unacked DM does not wake the same session again",
					again.json?.wake === false && again.json?.reason === "timeout",
					again.json,
				);
				s.obs("first_dm_message_id", msgId);

				const carolWait = api.wake("carol", "proof-carol-1", 2500);
				await sleep(300);
				const other = await send(api, A, B, "proof-dm-2: addressed to bob, pending");
				const carolResult = await carolWait;
				s.check(
					"DM addressed to bob does not wake carol's waiter",
					carolResult.json?.wake === false && carolResult.json?.reason === "timeout",
					carolResult.json,
				);
				const t1 = Date.now();
				const pending = await api.wake("bob", "proof-bob-1", 10_000);
				s.check(
					"DM sent while bob had no waiter is delivered immediately on the next poll",
					pending.json?.wake === true &&
						has(pending.json?.messageIds, other.json?.message?.id) &&
						Date.now() - t1 < 2_000,
					{ ids: pending.json?.messageIds, ms: Date.now() - t1 },
				);
			},
		);

		await step(
			id("L04-board-never-wakes"),
			"Board thread/reply activity never wakes a DM waiter (with DM positive control)",
			async (s) => {
				const msgBefore = count(ws, "cross_agent_messages");
				const wakesBefore = count(ws, "cross_agent_message_wakes");
				const t0 = Date.now();
				const waiting = api.wake("bob", "proof-bob-1", 4_000);
				await sleep(400);
				const thread = await api.post("/api/board/threads", {
					topic: "wake-isolation",
					title: "Board noise must not wake bob",
					body: "@bob-1 please look (board only)",
					agentId: "alice",
					sessionKey: "proof-alice-1",
					harness: HARNESS,
				});
				s.check("board thread created over HTTP", thread.status === 201 && !!thread.json?.thread?.id, {
					status: thread.status,
				});
				const reply = await api.post(`/api/board/threads/${thread.json?.thread?.id}/posts`, {
					body: "reply that names bob directly",
					agentId: "alice",
					sessionKey: "proof-alice-1",
				});
				s.check("board reply accepted", reply.status === 201, reply.status);
				const result = await waiting;
				s.check(
					"waiter ends by timeout, not wake, despite board activity",
					result.json?.wake === false && result.json?.reason === "timeout" && result.ms >= 3_500,
					{ json: result.json, ms: result.ms, since: Date.now() - t0 },
				);
				s.check("no cross_agent_messages created by board writes", count(ws, "cross_agent_messages") === msgBefore, {
					before: msgBefore,
					after: count(ws, "cross_agent_messages"),
				});
				s.check("no wake claims created by board writes", count(ws, "cross_agent_message_wakes") === wakesBefore, {
					before: wakesBefore,
					after: count(ws, "cross_agent_message_wakes"),
				});
				const t1 = Date.now();
				const waiting2 = api.wake("bob", "proof-bob-1", 10_000);
				await sleep(400);
				const dm = await send(api, A, B, "proof-dm-3: positive control after board activity");
				const woke = await waiting2;
				s.check(
					"positive control: a DM still wakes the same waiting session",
					woke.json?.wake === true && has(woke.json?.messageIds, dm.json?.message?.id) && Date.now() - t1 < 6_000,
					{ ids: woke.json?.messageIds, ms: woke.ms },
				);
			},
		);
	}

	if (full || phase === "ack" || phase === "release") {
		await step(
			id("L05-ack-and-refusal-release"),
			"Release re-arms wake, ack stops redispatch even after release",
			async (s) => {
				const sess: [string, string] = ["bob", "proof-bob-1"];
				const m1 = (await send(api, A, B, `proof-dm-ack-release ${randomBytes(3).toString("hex")}`)).json?.message?.id;
				const w1 = await api.wake(sess[0], sess[1], 5_000);
				s.check("first wake claims the DM", w1.json?.wake === true && has(w1.json?.messageIds, m1), w1.json);
				const idle = await api.wake(sess[0], sess[1], 1200);
				s.check("without release it is not redispatched", idle.json?.wake === false, idle.json);
				const wrongSession = await api.post("/api/cross-agent/wake/release", {
					agentId: "bob",
					sessionKey: "proof-bob-2",
					messageIds: [m1],
				});
				s.check(
					"release by a different session of the same agent releases nothing",
					wrongSession.json?.released === 0,
					wrongSession.json,
				);
				const rel = await api.post("/api/cross-agent/wake/release", {
					agentId: "bob",
					sessionKey: sess[1],
					messageIds: [m1],
				});
				s.check("refusal release deletes exactly one claim", rel.status === 200 && rel.json?.released === 1, rel.json);
				s.check(
					"claim row gone from DB",
					count(ws, "cross_agent_message_wakes", "message_id = ?", m1) === 0,
					count(ws, "cross_agent_message_wakes", "message_id = ?", m1),
				);
				const w2 = await api.wake(sess[0], sess[1], 5_000);
				s.check(
					"after release the same DM wakes again",
					w2.json?.wake === true && has(w2.json?.messageIds, m1),
					w2.json,
				);
				if (phase === "release") return;
				const ack = await api.post(`/api/cross-agent/messages/${m1}/ack`, { agentId: "bob", sessionKey: sess[1] });
				s.check("ack accepted", ack.status === 200, { status: ack.status, body: ack.json });
				const receipt = sql<Row>(
					ws,
					"SELECT acknowledged_at FROM cross_agent_message_receipts WHERE message_id = ? AND agent_id = 'bob'",
					m1,
				);
				s.check("ack receipt persisted", receipt.length === 1 && !!receipt[0]?.acknowledged_at, receipt);
				const rel2 = await api.post("/api/cross-agent/wake/release", {
					agentId: "bob",
					sessionKey: sess[1],
					messageIds: [m1],
				});
				s.check("release after ack still removes the claim row", rel2.json?.released === 1, rel2.json);
				const w3 = await api.wake(sess[0], sess[1], 2_000);
				s.check(
					"acknowledged DM is not redispatched even with claim released",
					w3.json?.wake === false && w3.json?.reason === "timeout",
					w3.json,
				);
				s.obs("ack_release_message_id", m1);
			},
		);
	}

	if (full) {
		await step(
			id("L06-wake-rate-refund"),
			"30/h wake budget: 31st is rate_limited, release refunds a slot",
			async (s) => {
				const R: [string, string] = ["bob", "proof-bob-rate"];
				await presence(api, R[0], R[1]);
				const claimed: string[] = [];
				for (let i = 0; i < 30; i++) {
					const m = await send(api, A, R, `proof-rate-${i}`);
					const w = await api.wake(R[0], R[1], 5_000);
					if (!(w.json?.wake === true && has(w.json?.messageIds, m.json?.message?.id))) {
						s.check(`wake ${i + 1}/30 delivered`, false, w.json);
						return;
					}
					claimed.push(must(m.json?.message?.id, "claimed message id"));
				}
				s.check("30 sequential DM wakes were delivered", claimed.length === 30, claimed.length);
				const m31 = (await send(api, A, R, "proof-rate-31")).json?.message?.id;
				const limited = await api.wake(R[0], R[1], 5_000);
				s.check(
					"31st wake attempt is rate_limited with retryAfterMs",
					limited.json?.wake === false &&
						limited.json?.reason === "rate_limited" &&
						(limited.json?.retryAfterMs ?? 0) >= 1000,
					limited.json,
				);
				const rel = await api.post("/api/cross-agent/wake/release", {
					agentId: R[0],
					sessionKey: R[1],
					messageIds: [claimed[29]],
				});
				s.check("refusal release of one delivered DM", rel.json?.released === 1, rel.json);
				const after = await api.wake(R[0], R[1], 5_000);
				s.check(
					"release refunds budget: next wake delivers (queued 31st or released 30th)",
					after.json?.wake === true && (has(after.json?.messageIds, m31) || has(after.json?.messageIds, claimed[29])),
					after.json,
				);
			},
		);
	}

	if (full) {
		await step(
			id("L07-cancellation-supersede-validation"),
			"Abort/supersede/validation behave cleanly; daemon stays responsive",
			async (s) => {
				const controller = new AbortController();
				const aborted = api.wake("bob", "proof-bob-2", 20_000, controller.signal).then(
					() => "resolved",
					(e: Error) => e.name,
				);
				await sleep(500);
				const t0 = Date.now();
				const health = await fetch(`${daemonHolder.daemon.base}/health`, { signal: AbortSignal.timeout(3_000) });
				s.check("health responsive while a 20s waiter is pending", health.ok && Date.now() - t0 < 1_000, {
					ms: Date.now() - t0,
				});
				controller.abort();
				s.check("client abort ends the request", (await aborted) === "AbortError", await Promise.resolve("AbortError"));
				await sleep(300);
				const dm = await send(api, A, ["bob", "proof-bob-2"], "proof-dm-after-abort");
				s.check(
					"DM to an aborted waiter is not claimed by the dead waiter",
					count(ws, "cross_agent_message_wakes", "message_id = ?", dm.json?.message?.id) === 0,
					count(ws, "cross_agent_message_wakes", "message_id = ?", dm.json?.message?.id),
				);
				const fresh = await api.wake("bob", "proof-bob-2", 5_000);
				s.check(
					"a fresh poll receives it (not swallowed)",
					fresh.json?.wake === true && has(fresh.json?.messageIds, dm.json?.message?.id),
					fresh.json,
				);
				const first = api.wake("bob", "proof-bob-1", 8_000);
				await sleep(300);
				const second = api.wake("bob", "proof-bob-1", 800);
				const [firstResult, secondResult] = await Promise.all([first, second]);
				s.check(
					"a second poll for the same session supersedes the first",
					firstResult.json?.reason === "superseded" && secondResult.json?.reason === "timeout",
					{ first: firstResult.json, second: secondResult.json },
				);
				const bad1 = await api.call("POST", "/api/cross-agent/wake", { harness: HARNESS, sessionKey: "x", waitMs: -5 });
				const bad2 = await api.call("POST", "/api/cross-agent/wake", { harness: HARNESS });
				const zero = await api.wake("bob", "proof-bob-1", 0);
				s.check(
					"negative waitMs / missing sessionKey -> 400; waitMs=0 -> immediate timeout",
					bad1.status === 400 && bad2.status === 400 && zero.json?.reason === "timeout" && zero.ms < 1_000,
					{ bad1: bad1.status, bad2: bad2.status, zero: zero.json, zeroMs: zero.ms },
				);
			},
		);
	}

	if (full || phase === "snapshot") {
		await step(
			id("L08-board-thread-pagination-snapshot"),
			"Real topic/thread/reply/pagination; readThroughPostId == page snapshot; stale/foreign cursors",
			async (s) => {
				const topic = await api.post("/api/board/topics", {
					slug: "runtime-proof",
					title: "Runtime proof",
					agentId: "alice",
					sessionKey: A[1],
				});
				s.check(
					"topic created (201) then idempotent (200)",
					topic.status === 201 &&
						(await api.post("/api/board/topics", { slug: "runtime-proof", agentId: "alice", sessionKey: A[1] }))
							.status === 200,
					topic.status,
				);
				const created = await api.post("/api/board/threads", {
					topic: "runtime-proof",
					title: "Pagination proof",
					body: "root post by alice",
					tags: ["proof", "pagination"],
					agentId: "alice",
					sessionKey: A[1],
					harness: HARNESS,
				});
				const threadId = created.json?.thread?.id;
				const rootId = created.json?.post?.id;
				s.check("thread + root post created", created.status === 201 && !!threadId && !!rootId, {
					status: created.status,
					projection: created.json?.projection,
				});
				const postIds: string[] = [must(rootId, "root post id")];
				for (let i = 1; i <= 6; i++) {
					const byBob = i % 2 === 1;
					const reply = await api.post(`/api/board/threads/${threadId}/posts`, {
						body: `reply ${i} by ${byBob ? "bob" : "alice"}`,
						replyToPostId: postIds[postIds.length - 1],
						agentId: byBob ? "bob" : "alice",
						sessionKey: byBob ? B[1] : A[1],
					});
					if (reply.status !== 201) s.check(`reply ${i} created`, false, reply.status);
					postIds.push(must(reply.json?.post?.id, "reply post id"));
				}
				const page1 = await api.get(`/api/board/threads/${threadId}?limit=3&offset=0&agent_id=bob&session_key=${B[1]}`);
				const p1ids = (page1.json?.posts ?? []).map((p: Entity) => p.id);
				s.check(
					"page 1 returns first 3 posts in insertion order",
					JSON.stringify(p1ids) === JSON.stringify(postIds.slice(0, 3)) &&
						page1.json?.hasMorePosts === true &&
						page1.json?.postTotal === 7,
					{ n: p1ids.length, hasMore: page1.json?.hasMorePosts, total: page1.json?.postTotal },
				);
				s.check(
					"readThroughPostId equals the last post of the page snapshot",
					page1.json?.readThroughPostId === postIds[2],
					{ readThroughPostId: page1.json?.readThroughPostId, expected: postIds[2] },
				);
				const page2 = await api.get(`/api/board/threads/${threadId}?limit=3&offset=3&agent_id=bob`);
				const page3 = await api.get(`/api/board/threads/${threadId}?limit=3&offset=6&agent_id=bob`);
				s.check(
					"offset pages contiguous, last page has no more; offset pages carry no readThroughPostId",
					JSON.stringify((page2.json?.posts ?? []).map((p: Entity) => p.id)) === JSON.stringify(postIds.slice(3, 6)) &&
						page3.json?.posts?.length === 1 &&
						page3.json?.hasMorePosts === false &&
						page2.json?.readThroughPostId === undefined,
					{ p2: page2.json?.posts?.length, p3: page3.json?.posts?.length },
				);
				const late = await api.post(`/api/board/threads/${threadId}/posts`, {
					body: "late reply by alice after bob fetched page 1",
					agentId: "alice",
					sessionKey: A[1],
				});
				const latePost = late.json?.post?.id;
				const mark = await api.post(`/api/board/threads/${threadId}/read`, {
					throughPostId: page1.json?.readThroughPostId,
					agentId: "bob",
					sessionKey: B[1],
				});
				s.check(
					"mark-read with page snapshot stores the snapshot post, not the newer head",
					mark.status === 200 && mark.json?.lastReadPostId === postIds[2] && mark.json?.lastReadPostId !== latePost,
					mark.json,
				);
				const dbRead = sql<Row>(
					ws,
					"SELECT last_read_post_seq FROM board_reads WHERE agent_id = 'bob' AND thread_id = ?",
					threadId,
				);
				const seqOfSnapshot = Number(
					must(sql<Row>(ws, "SELECT seq FROM board_posts WHERE id = ?", postIds[2])[0]?.seq, "snapshot seq"),
				);
				s.check(
					"DB board_reads.last_read_post_seq equals seq of snapshot post",
					dbRead[0]?.last_read_post_seq === seqOfSnapshot,
					{ dbRead, seqOfSnapshot },
				);
				const stale = await api.post(`/api/board/threads/${threadId}/read`, {
					throughPostId: postIds[0],
					agentId: "bob",
					sessionKey: B[1],
				});
				s.check(
					"stale cursor never moves the saved position backward",
					stale.json?.lastReadPostId === postIds[2],
					stale.json,
				);
				const otherThread = await api.post("/api/board/threads", {
					topic: "runtime-proof",
					title: "Other thread",
					body: "different thread",
					agentId: "alice",
					sessionKey: A[1],
				});
				const foreign = await api.post(`/api/board/threads/${threadId}/read`, {
					throughPostId: otherThread.json?.post?.id,
					agentId: "bob",
					sessionKey: B[1],
				});
				s.check("post id from another thread is rejected with 400", foreign.status === 400, {
					status: foreign.status,
					body: foreign.json,
				});
				const notices = await api.post("/api/hooks/user-prompt-submit", {
					harness: HARNESS,
					userMessage: "runtime proof prompt",
					sessionKey: B[1],
					agentId: "bob",
					project: HOOK_PROJECT,
				});
				const bn = notices.json?.notifications?.boardNotices ?? [];
				const mine = bn.find((n: Entity) => n.threadId === threadId);
				const rowsAfter = sql<Row>(
					ws,
					"SELECT author_agent_id AS a, author_session_key AS s, seq FROM board_posts WHERE thread_id = ? ORDER BY seq",
					threadId,
				);
				const ownMax = Math.max(
					0,
					...rowsAfter.filter((r: Row) => r.a === "bob" && r.s === B[1]).map((r: Row) => Number(r.seq)),
				);
				const seen = Math.max(seqOfSnapshot, ownMax);
				const expectNewPosts = rowsAfter.filter(
					(r: Row) => Number(r.seq) > seen && !(r.a === "bob" && r.s === B[1]),
				).length;
				s.obs("notice_expectation", {
					snapshotSeq: seqOfSnapshot,
					bobOwnMaxSeq: ownMax,
					expectedNewPosts: expectNewPosts,
					postsAfterSnapshotByOthers: rowsAfter.filter(
						(r: Row) => Number(r.seq) > seqOfSnapshot && !(r.a === "bob" && r.s === B[1]),
					).length,
				});
				s.check(
					"hook notice counts only posts by other sessions beyond max(snapshot, own latest post), incl. the late reply",
					!!mine && mine.newPosts === expectNewPosts && expectNewPosts >= 1,
					{ notice: mine, expectNewPosts, status: notices.status },
				);
				const noticesAgain = await api.post("/api/hooks/user-prompt-submit", {
					harness: HARNESS,
					userMessage: "second prompt",
					sessionKey: B[1],
					agentId: "bob",
					project: HOOK_PROJECT,
				});
				s.check(
					"notice is delivered once per session (second hook has none for the thread)",
					!(noticesAgain.json?.notifications?.boardNotices ?? []).some((n: Entity) => n.threadId === threadId),
					noticesAgain.json?.notifications?.boardNotices ?? null,
				);
				const head = await api.post(`/api/board/threads/${threadId}/read`, { agentId: "bob", sessionKey: B[1] });
				s.check("no cursor marks the current head", head.json?.lastReadPostId === latePost, head.json);
				s.obs("thread_id", threadId);
				s.obs("post_ids", [...postIds, latePost]);
				s.obs("other_thread_id", otherThread.json?.thread?.id);
				shared.board = {
					threadId: must(threadId, "thread id"),
					postIds: [...postIds, must(latePost, "late post id")],
					otherThreadId: must(otherThread.json?.thread?.id, "other thread id"),
				};
			},
		);
	}

	if (full) {
		await step(
			id("L09-scoped-visibility-and-events"),
			"Isolated agent cannot read/reply/see; SSE events are visibility-scoped; archived rejects replies",
			async (s) => {
				const ids = must(shared.board, "board ids");
				const carolRead = await api.get(`/api/board/threads/${ids.threadId}?agent_id=carol`);
				s.check("isolated carol gets 404 for alice's thread", carolRead.status === 404, carolRead.status);
				const carolReply = await api.post(`/api/board/threads/${ids.threadId}/posts`, {
					body: "carol must not reply",
					agentId: "carol",
					sessionKey: C[1],
				});
				s.check("isolated carol cannot reply (404)", carolReply.status === 404, carolReply.status);
				const carolList = await api.get("/api/board/threads?agent_id=carol&topic=runtime-proof&status=all");
				s.check(
					"isolated carol's thread list excludes alice's threads",
					(carolList.json?.items ?? []).every((t: Entity) => t.authorAgentId === "carol"),
					(carolList.json?.items ?? []).length,
				);
				const bobList = await api.get("/api/board/threads?agent_id=bob&topic=runtime-proof&tag=pagination&status=all");
				s.check(
					"shared bob lists alice's thread via topic+tag filters",
					(bobList.json?.items ?? []).some((t: Entity) => t.id === ids.threadId),
					bobList.json?.total,
				);
				const topicsCarol = await api.get("/api/board/topics?agent_id=carol");
				const topicsBob = await api.get("/api/board/topics?agent_id=bob");
				const countOf = (res: Api) =>
					(res.json?.topics ?? []).find((t: Entity) => t.slug === "runtime-proof")?.threadCount ??
					(res.json?.topics ?? []).find((t: Entity) => t.slug === "runtime-proof")?.threads ??
					0;
				s.check("topic thread counts are viewer-scoped (bob > carol)", countOf(topicsBob) > countOf(topicsCarol), {
					bob: countOf(topicsBob),
					carol: countOf(topicsCarol),
				});
				const operator = await api.get(`/api/board/threads/${ids.threadId}?scope=all&limit=1`);
				s.check("operator scope=all (local mode) reads the thread", operator.status === 200, operator.status);

				const bobStream = await api.sse("/api/board/stream?agent_id=bob");
				const carolStream = await api.sse("/api/board/stream?agent_id=carol");
				await Promise.race([Promise.all([bobStream.ready, carolStream.ready]), sleep(2_000)]);
				await sleep(300);
				const live = await api.post(`/api/board/threads/${ids.threadId}/posts`, {
					body: "streamed new reply by alice",
					agentId: "alice",
					sessionKey: A[1],
				});
				const livePost = live.json?.post?.id;
				await sleep(1_200);
				const bobSaw = bobStream.events.some((e) => JSON.stringify(e).includes(ids.threadId));
				const carolSaw = carolStream.events.some((e) => JSON.stringify(e).includes(ids.threadId));
				s.check("shared bob's stream receives the new reply event", bobSaw, bobStream.events.slice(-3));
				s.check(
					"isolated carol's stream does NOT receive alice's thread event",
					!carolSaw,
					carolStream.events.slice(-3),
				);
				const own = await api.post("/api/board/threads", {
					topic: "carol-private",
					title: "Carol thread",
					body: "carol only",
					agentId: "carol",
					sessionKey: C[1],
				});
				await sleep(1_000);
				s.check(
					"control: carol's stream does receive carol's own thread event",
					carolStream.events.some((e) => JSON.stringify(e).includes(String(own.json?.thread?.id))),
					carolStream.events.slice(-3),
				);
				bobStream.close();
				carolStream.close();
				must(shared.board, "board ids").carolThreadId = own.json?.thread?.id;
				must(shared.board, "board ids").livePost = livePost;

				const archThread = await api.post("/api/board/threads", {
					topic: "runtime-proof",
					title: "Archive me",
					body: "to archive",
					agentId: "alice",
					sessionKey: A[1],
				});
				const atid = archThread.json?.thread?.id;
				const bobPatch = await api.patch(`/api/board/threads/${atid}`, {
					status: "archived",
					agentId: "bob",
					sessionKey: B[1],
				});
				s.check("non-author (bob) cannot archive alice's thread (403)", bobPatch.status === 403, bobPatch.status);
				const alicePatch = await api.patch(`/api/board/threads/${atid}`, {
					status: "archived",
					agentId: "alice",
					sessionKey: A[1],
				});
				s.check(
					"author can archive",
					alicePatch.status === 200 && alicePatch.json?.thread?.status === "archived",
					alicePatch.json?.thread?.status,
				);
				const replyArchived = await api.post(`/api/board/threads/${atid}/posts`, {
					body: "too late",
					agentId: "bob",
					sessionKey: B[1],
				});
				s.check("reply to archived thread -> 409", replyArchived.status === 409, replyArchived.status);
				const defaultList = await api.get("/api/board/threads?agent_id=alice&topic=runtime-proof");
				s.check(
					"archived thread hidden from default list",
					!(defaultList.json?.items ?? []).some((t: Entity) => t.id === atid),
					(defaultList.json?.items ?? []).length,
				);
			},
		);

		await step(
			id("L10-projection-and-operator-moderation"),
			"Dreaming source projection exists per post; operator moderation + thread delete purges it",
			async (s) => {
				const ids = must(shared.board, "board ids");
				const rowsBefore = sql<Row>(
					ws,
					"SELECT agent_id, source_path FROM memory_artifacts WHERE source_kind = 'board_post' AND source_parent_path = ?",
					`signet-board://thread/${ids.threadId}`,
				);
				const paths = new Set(rowsBefore.map((r: Row) => r.source_path));
				s.obs("projected_artifacts_before_delete", {
					rows: rowsBefore.length,
					distinctPaths: paths.size,
					agents: [...new Set(rowsBefore.map((r: Row) => r.agent_id))].sort(),
				});
				const allPosts = sql<Row>(ws, "SELECT id FROM board_posts WHERE thread_id = ?", ids.threadId).map(
					(r: Row) => r.id,
				);
				s.check(
					"every board post has a projected artifact at signet-board://thread/<t>/post/<p>",
					allPosts.length >= 8 && allPosts.every((p) => paths.has(`signet-board://thread/${ids.threadId}/post/${p}`)),
					{ posts: allPosts.length, paths: paths.size },
				);
				const bobPin = await api.patch(`/api/board/threads/${ids.threadId}`, {
					pinned: true,
					agentId: "bob",
					sessionKey: B[1],
				});
				s.check("non-author, non-operator cannot pin (403)", bobPin.status === 403, bobPin.status);
				const bobDelete = await api.call("DELETE", `/api/board/threads/${ids.threadId}?agent_id=bob`);
				s.check("agent cannot delete a thread (403)", bobDelete.status === 403, bobDelete.status);
				const aliceDelete = await api.call("DELETE", `/api/board/threads/${ids.threadId}?agent_id=alice`);
				s.check("even the author cannot delete (operator only)", aliceDelete.status === 403, aliceDelete.status);
				const opPin = await api.patch(`/api/board/threads/${ids.threadId}`, { pinned: true, scope: "all" });
				s.check(
					"operator can pin (scope=all)",
					opPin.status === 200 && opPin.json?.thread?.pinned === true,
					opPin.json?.thread?.pinned,
				);
				const opDelete = await api.call("DELETE", `/api/board/threads/${ids.threadId}?scope=all`);
				s.check(
					"operator deletes thread, reporting deleted posts",
					opDelete.status === 200 && opDelete.json?.deletedPosts === allPosts.length,
					opDelete.json,
				);
				s.check(
					"posts removed from DB",
					count(ws, "board_posts", "thread_id = ?", ids.threadId) === 0,
					count(ws, "board_posts", "thread_id = ?", ids.threadId),
				);
				s.check(
					"Dreaming projections for the thread removed from memory_artifacts",
					count(
						ws,
						"memory_artifacts",
						"source_kind = 'board_post' AND source_parent_path = ?",
						`signet-board://thread/${ids.threadId}`,
					) === 0,
					count(
						ws,
						"memory_artifacts",
						"source_kind = 'board_post' AND source_parent_path = ?",
						`signet-board://thread/${ids.threadId}`,
					),
				);
				s.check(
					"deleted thread now 404 for every viewer",
					(await api.get(`/api/board/threads/${ids.threadId}?scope=all`)).status === 404,
					null,
				);
				s.check(
					"sibling threads and their projections untouched",
					count(ws, "board_threads", "id = ?", ids.carolThreadId) === 1 &&
						count(
							ws,
							"memory_artifacts",
							"source_kind = 'board_post' AND source_parent_path = ?",
							`signet-board://thread/${ids.carolThreadId}`,
						) >= 1,
					null,
				);
			},
		);
	}
}

async function agentPurgeObservation(wsInfo: Workspace, holder: { daemon: Daemon }): Promise<void> {
	await step(
		"L11-agent-purge-vs-board-rows",
		"OBSERVATION: DELETE /api/agents/carol?purge=true effect on carol's board rows and projections",
		async (s) => {
			const api = new Client(() => holder.daemon.base);
			const before = {
				threads: count(wsInfo.ws, "board_threads", "author_agent_id = 'carol'"),
				posts: count(wsInfo.ws, "board_posts", "author_agent_id = 'carol'"),
				artifacts: count(wsInfo.ws, "memory_artifacts", "source_kind = 'board_post' AND agent_id = 'carol'"),
			};
			const res = await api.del("/api/agents/carol?purge=true");
			const after = {
				threads: count(wsInfo.ws, "board_threads", "author_agent_id = 'carol'"),
				posts: count(wsInfo.ws, "board_posts", "author_agent_id = 'carol'"),
				artifacts: count(wsInfo.ws, "memory_artifacts", "source_kind = 'board_post' AND agent_id = 'carol'"),
			};
			s.obs("purge_http", { status: res.status, body: res.json });
			s.obs("carol_board_rows_before", before);
			s.obs("carol_board_rows_after", after);
			s.obs(
				"interpretation",
				after.threads > 0 || after.posts > 0 || after.artifacts > 0
					? "agent purge left board rows and/or board_post projections for the purged agent (not asserted as a defect: intended retention is not stated by the PR docs)"
					: "agent purge removed board rows and projections for the purged agent",
			);
			s.check("purge request returned an HTTP result", res.status === 200 || res.status === 204, res.status);
		},
		"observation",
	);
}

async function restartScenario(wsInfo: Workspace, holder: { daemon: Daemon }): Promise<void> {
	const ws = wsInfo.ws;
	const api = new Client(() => holder.daemon.base);
	const ids = must(shared.board, "board ids");
	const B: [string, string] = ["bob", "proof-bob-1"];
	const A: [string, string] = ["alice", "proof-alice-1"];
	const pre: Pre = {};
	await step(
		"R01-capture-pre-restart-state",
		"Capture durable state and queue a pending DM before restart",
		async (s) => {
			const pending = await send(api, A, B, "proof-dm-pending-before-restart");
			pre.pendingId = pending.json?.message?.id;
			pre.pendingWaked = count(ws, "cross_agent_message_wakes", "message_id = ?", pre.pendingId);
			pre.migration = sql<Row>(ws, "SELECT version, applied_at FROM schema_migrations WHERE version = 171")[0];
			pre.otherThread = (await api.get(`/api/board/threads/${ids.otherThreadId}?scope=all`)).json;
			pre.bobCursor = (
				await api.post(`/api/board/threads/${ids.carolThreadId}/read`, { agentId: "alice", sessionKey: A[1] })
			).status;
			pre.counts = {
				board_threads: count(ws, "board_threads"),
				board_posts: count(ws, "board_posts"),
				board_reads: count(ws, "board_reads"),
				cross_agent_messages: count(ws, "cross_agent_messages"),
				cross_agent_message_wakes: count(ws, "cross_agent_message_wakes"),
				cross_agent_message_receipts: count(ws, "cross_agent_message_receipts"),
				memory_artifacts_board: count(ws, "memory_artifacts", "source_kind = 'board_post'"),
			};
			pre.presenceBob = (
				await api.get(`/api/cross-agent/presence?agent_id=alice&include_self=true&limit=50`)
			).json?.sessions
				?.map((x: Entity) => x.sessionKey)
				.sort();
			pre.health = (await (await fetch(`${holder.daemon.base}/health`)).json()) as unknown;
			s.check("pending DM queued and unclaimed before restart", !!pre.pendingId && pre.pendingWaked === 0, {
				id: pre.pendingId,
				claims: pre.pendingWaked,
			});
			s.obs("counts_before", pre.counts);
			s.obs("migration_171_before", pre.migration);
			s.obs("presence_before_restart", pre.presenceBob);
		},
	);

	for (const mode of ["graceful", "kill9"] as const) {
		const oldPid = holder.daemon.pid;
		await step(
			`R02-restart-${mode}`,
			`Restart daemon (${mode}) on the same workspace; durable state intact`,
			async (s) => {
				const stopped = await stopDaemon(holder.daemon, mode);
				s.obs("stop", stopped);
				s.check(
					"old daemon process group gone and port released",
					!pidAlive(oldPid) && stopped.survivors.length === 0,
					{ alive: pidAlive(oldPid), survivors: stopped.survivors },
				);
				const fresh = await startDaemon(wsInfo, join(REPO, "platform", "daemon"), `after-${mode}`);
				holder.daemon = fresh;
				s.check("new daemon pid differs from the old one", fresh.pid !== oldPid, { old: oldPid, new: fresh.pid });
				const counts = {
					board_threads: count(ws, "board_threads"),
					board_posts: count(ws, "board_posts"),
					board_reads: count(ws, "board_reads"),
					cross_agent_messages: count(ws, "cross_agent_messages"),
					cross_agent_message_wakes: count(ws, "cross_agent_message_wakes"),
					cross_agent_message_receipts: count(ws, "cross_agent_message_receipts"),
					memory_artifacts_board: count(ws, "memory_artifacts", "source_kind = 'board_post'"),
				};
				s.obs("counts_after", counts);
				const durableKeys = [
					"board_threads",
					"board_posts",
					"board_reads",
					"cross_agent_messages",
					"cross_agent_message_receipts",
					"memory_artifacts_board",
				] as const;
				s.check(
					"board, message, receipt and projection row counts unchanged across restart",
					durableKeys.every((k) => counts[k] === pre.counts?.[k]),
					{ before: pre.counts, after: counts },
				);
				const migration = sql<Row>(ws, "SELECT version, applied_at FROM schema_migrations WHERE version = 171")[0];
				s.check(
					"migration 171 persisted and not re-applied (same applied_at)",
					migration?.applied_at === pre.migration?.applied_at,
					{ before: pre.migration, after: migration },
				);
				const client = new Client(() => holder.daemon.base);
				const again = await client.get(`/api/board/threads/${ids.otherThreadId}?scope=all`);
				s.check(
					"thread detail over HTTP identical after restart",
					JSON.stringify(again.json?.posts) === JSON.stringify(pre.otherThread?.posts) &&
						again.json?.thread?.id === ids.otherThreadId,
					{ status: again.status },
				);
				const presenceAfter =
					(await client.get("/api/cross-agent/presence?agent_id=alice&include_self=true&limit=50")).json?.sessions
						?.map((x: Entity) => x.sessionKey)
						.sort() ?? [];
				s.obs(`presence_after_${mode}`, presenceAfter);
				s.obs(`presence_persisted_after_${mode}`, presenceAfter.length > 0);
				if (mode === "graceful") {
					const waker = await client.wake(B[0], B[1], 8_000);
					s.check(
						"pending DM queued before restart wakes the session after restart",
						waker.json?.wake === true && has(waker.json?.messageIds, pre.pendingId),
						waker.json,
					);
					const idle = await client.wake(B[0], B[1], 1_500);
					s.check(
						"claimed (persisted wake row) and acked DMs are not redispatched after restart",
						idle.json?.wake === false && idle.json?.reason === "timeout",
						idle.json,
					);
				}
			},
		);
	}
}

async function teamScenario(daemonDir: string): Promise<void> {
	const port = await freePort();
	const wsInfo = makeWorkspace("team", "team", port);
	let daemon: Daemon | null = null;
	await step(
		"T01-team-mode-boot-and-tokens",
		"Boot team-mode daemon; mint scoped tokens with the daemon's own token code",
		async (s) => {
			initDb(wsInfo, daemonDir);
			daemon = await boot(wsInfo, daemonDir, "team", s);
			const secretPath = join(wsInfo.ws, ".daemon", "auth-secret");
			const layoutSecret =
				Bun.spawnSync(["find", wsInfo.ws, "-name", "auth-secret"]).stdout.toString().trim().split("\n")[0] ??
				secretPath;
			s.check(
				"daemon created its auth secret in the scratch workspace",
				existsSync(layoutSecret),
				redact(layoutSecret),
			);
			const secret = loadOrCreateSecret(layoutSecret);
			const mint = (role: "admin" | "agent" | "readonly", agent?: string) =>
				createToken(secret, { sub: `proof:${role}:${agent ?? "none"}`, scope: agent ? { agent } : {}, role }, 3600);
			shared.tokens = {
				admin: mint("admin"),
				alice: mint("agent", "alice"),
				bob: mint("agent", "bob"),
				readonly: mint("readonly", "alice"),
			};
			shared.teamHolder = { daemon };
			const none = await new Client(() => must(daemon, "daemon").base).get("/api/board/topics");
			s.check("no token -> 401", none.status === 401, none.status);
			redactions.push(
				...Object.entries(must(shared.tokens, "tokens")).map(([k, v]) => [v, `<token:${k}>`] as [string, string]),
			);
		},
	);
	if (!daemon) return;
	const holder = must(shared.teamHolder, "team holder");
	const tok = must(shared.tokens, "tokens");
	const base = () => holder.daemon.base;
	const admin = new Client(base, tok.admin);
	const alice = new Client(base, tok.alice);
	const bob = new Client(base, tok.bob);
	const readonly = new Client(base, tok.readonly);
	const S = "proof-shared-session";

	await step(
		"T02-same-session-other-agent-token-rejected",
		"A session registered by alice cannot be used by bob's token on wake/DM/ack/release/presence/board",
		async (s) => {
			for (const name of ["alice", "bob"]) {
				const res = await admin.post("/api/agents", { name, read_policy: "shared" });
				s.check(`admin created agent ${name}`, res.status === 201, res.status);
			}
			const reg = await presence(alice, "alice", S);
			s.check(
				"alice registers session S under her own token",
				reg.status === 200 && reg.json?.presence?.agentId === "alice",
				{ status: reg.status, body: reg.json },
			);
			const regBob = await presence(bob, "bob", "proof-bob-own");
			s.check("bob registers his own session", regBob.status === 200, regBob.status);
			const before = {
				boards: count(wsInfo.ws, "board_threads"),
				messages: count(wsInfo.ws, "cross_agent_messages"),
				wakes: count(wsInfo.ws, "cross_agent_message_wakes"),
			};
			const hijack = await presence(bob, "bob", S);
			s.check("bob token cannot re-register alice's session key (403)", hijack.status === 403, {
				status: hijack.status,
				body: hijack.json,
			});
			const wakeHijack = await bob.wake("bob", S, 500);
			s.check("bob token cannot long-poll alice's session (403)", wakeHijack.status === 403, {
				status: wakeHijack.status,
				body: wakeHijack.json,
			});
			const sendHijack = await bob.post("/api/cross-agent/messages", {
				content: "forged sender session",
				fromAgentId: "bob",
				fromSessionKey: S,
				toAgentId: "alice",
			});
			s.check("bob token cannot send as alice's session (403)", sendHijack.status === 403, {
				status: sendHijack.status,
				body: sendHijack.json,
			});
			const legit = await send(alice, ["alice", S], ["bob", "proof-bob-own"], "proof-team-dm");
			s.check(
				"positive control: alice sends a DM from her own session",
				legit.status === 200 && !!legit.json?.message?.id,
				{ status: legit.status, body: legit.json },
			);
			const mid = legit.json?.message?.id;
			const ackHijack = await bob.post(`/api/cross-agent/messages/${mid}/ack`, { agentId: "bob", sessionKey: S });
			s.check("bob token cannot ack using alice's session (403)", ackHijack.status === 403, {
				status: ackHijack.status,
				body: ackHijack.json,
			});
			const relHijack = await bob.post("/api/cross-agent/wake/release", {
				agentId: "bob",
				sessionKey: S,
				messageIds: [mid],
			});
			s.check("bob token cannot release wakes via alice's session (403)", relHijack.status === 403, {
				status: relHijack.status,
				body: relHijack.json,
			});
			const listHijack = await bob.get(`/api/cross-agent/messages?agent_id=bob&session_key=${S}`);
			s.check("bob token cannot list messages for alice's session (403)", listHijack.status === 403, {
				status: listHijack.status,
				body: listHijack.json,
			});
			const boardHijack = await bob.post("/api/board/threads", {
				topic: "hijack",
				title: "forged",
				body: "forged via alice session",
				agentId: "bob",
				sessionKey: S,
			});
			s.check("bob token cannot author a board thread with alice's session (403)", boardHijack.status === 403, {
				status: boardHijack.status,
				body: boardHijack.json,
			});
			const impersonate = await alice.post("/api/board/threads", {
				topic: "hijack",
				title: "forged",
				body: "alice claiming bob",
				agentId: "bob",
				sessionKey: S,
			});
			s.check("alice token cannot claim agentId=bob (403)", impersonate.status === 403, {
				status: impersonate.status,
				body: impersonate.json,
			});
			const impWake = await alice.wake("bob", "proof-bob-own", 500);
			s.check("alice token cannot long-poll as agent bob (403)", impWake.status === 403, {
				status: impWake.status,
				body: impWake.json,
			});
			const roPost = await readonly.post("/api/board/threads", {
				topic: "hijack",
				title: "ro",
				body: "readonly token",
				agentId: "alice",
				sessionKey: S,
			});
			s.check("readonly token cannot write the board (403)", roPost.status === 403, {
				status: roPost.status,
				body: roPost.json,
			});
			const scopeAll = await alice.get("/api/board/threads?scope=all");
			s.check("agent token cannot use scope=all (403)", scopeAll.status === 403, {
				status: scopeAll.status,
				body: scopeAll.json,
			});
			const adminAll = await admin.get("/api/board/threads?scope=all");
			s.check("admin token may use scope=all", adminAll.status === 200, adminAll.status);
			s.check(
				"no board/message/wake rows created by rejected requests",
				count(wsInfo.ws, "board_threads") === before.boards &&
					count(wsInfo.ws, "cross_agent_message_wakes") === before.wakes &&
					count(wsInfo.ws, "cross_agent_messages") === before.messages + 1,
				{
					before,
					after: {
						boards: count(wsInfo.ws, "board_threads"),
						messages: count(wsInfo.ws, "cross_agent_messages"),
						wakes: count(wsInfo.ws, "cross_agent_message_wakes"),
					},
				},
			);
			const keep = await alice.get(`/api/cross-agent/presence?agent_id=alice&session_key=${S}&include_self=true`);
			const boundS = (keep.json?.sessions ?? []).filter((x: Entity) => x.sessionKey === S);
			s.check(
				"session S still bound to alice (and only alice) after the rejected attempts",
				boundS.length === 1 && boundS[0]?.agentId === "alice",
				boundS.map((x: Entity) => ({ sessionKey: x.sessionKey, agentId: x.agentId })),
			);
			const own = await alice.post("/api/board/threads", {
				topic: "team-proof",
				title: "alice own thread",
				body: "legit via alice token",
				agentId: "alice",
				sessionKey: S,
			});
			s.check("positive control: alice posts to the board with her token and session", own.status === 201, {
				status: own.status,
			});
			const waitOwn = await alice.wake("alice", S, 300);
			s.check("positive control: alice long-polls her own session", waitOwn.status === 200, waitOwn.status);
		},
	);

	if (daemon) await stopDaemon(holder.daemon, "graceful");
}

async function mutationControl(spec: MutationSpec): Promise<void> {
	const root = join(scratchBase(), `signet-pr2181-mut-${randomBytes(4).toString("hex")}`);
	scratchRoots.push(root);
	mkdirSync(root, { recursive: true });
	redactions.push([root, "<SCRATCH>"]);
	const daemonCopy = join(root, "mutant", "platform", "daemon");
	mkdirSync(join(root, "mutant", "platform"), { recursive: true });
	cpSync(join(REPO, "platform", "daemon", "src"), join(daemonCopy, "src"), { recursive: true });
	cpSync(join(REPO, "platform", "daemon", "package.json"), join(daemonCopy, "package.json"));
	if (existsSync(join(REPO, "platform", "daemon", "tsconfig.json")))
		cpSync(join(REPO, "platform", "daemon", "tsconfig.json"), join(daemonCopy, "tsconfig.json"));
	for (const dir of ["skills", "dashboard"]) {
		if (existsSync(join(REPO, "platform", "daemon", dir)))
			symlinkSync(join(REPO, "platform", "daemon", dir), join(daemonCopy, dir));
	}
	symlinkSync(join(REPO, "platform", "daemon", "node_modules"), join(daemonCopy, "node_modules"));
	symlinkSync(join(REPO, "node_modules"), join(root, "mutant", "node_modules"));
	for (const dir of ["core", "sdk"]) {
		if (existsSync(join(REPO, "platform", dir)))
			symlinkSync(join(REPO, "platform", dir), join(root, "mutant", "platform", dir));
	}
	for (const dir of ["libs", "surfaces", "integrations", "plugins"]) {
		if (existsSync(join(REPO, dir))) symlinkSync(join(REPO, dir), join(root, "mutant", dir));
	}
	const target = join(root, "mutant", spec.file);
	const original = readFileSync(target, "utf8");
	const occurrences = original.split(spec.find).length - 1;
	if (occurrences !== 1 || spec.find === spec.replace) {
		notVerified(
			`MUT-${spec.id}`,
			`Mutation control ${spec.id}`,
			`mutation anchor must match exactly once and change the source (matches=${occurrences})`,
		);
		return;
	}
	const mutated = original.replace(spec.find, () => spec.replace);
	writeFileSync(target, mutated);
	if (readFileSync(join(REPO, spec.file), "utf8") !== original) throw new Error("mutation leaked into the real source");
	const port = await freePort();
	const wsInfo = makeWorkspace(`mut-${spec.scenario}`, "local", port);
	const before = steps.length;
	const holder = { daemon: null as unknown as Daemon };
	try {
		initDb(wsInfo, daemonCopy);
		holder.daemon = await startDaemon(wsInfo, daemonCopy, `mut-${spec.scenario}`);
		await localScenario(spec.scenario, wsInfo, holder, `@${spec.id}`);
	} catch (error) {
		steps.push({
			id: `MUT-${spec.id}-boot`,
			title: "mutant daemon boot",
			status: "not_verified",
			checks: [],
			observations: { reason: error instanceof Error ? redact(error.message).slice(0, 600) : String(error) },
			ms: 0,
		});
	} finally {
		if (holder.daemon) await stopDaemon(holder.daemon, "graceful");
	}
	const produced = steps.splice(before);
	const failedChecks = produced.flatMap((p) => p.checks.filter((c) => !c.pass).map((c) => c.name));
	const crashChecks = failedChecks.filter((n) => n === "step completed without exception");
	const matched = spec.expect.filter((name) => failedChecks.includes(name));
	const detected =
		matched.length === spec.expect.length &&
		crashChecks.length === 0 &&
		produced.every((p) => p.status !== "not_verified");
	steps.push({
		id: `MUT-${spec.id}`,
		title: `Negative control: mutated copy (${spec.file}) must make the harness FAIL`,
		status: detected ? "pass" : "fail",
		checks: [
			{
				name: "all expected real-daemon mutation assertions failed without an unrelated crash",
				pass: detected,
				observed: { failed: failedChecks, expected: spec.expect, unrelated_crashes: crashChecks },
			},
		],
		observations: {
			mutation: { file: spec.file, find: spec.find, replace: spec.replace },
			scenario: spec.scenario,
			inner_steps: produced.map((p) => ({
				id: p.id,
				status: p.status,
				failed: p.checks.filter((c) => !c.pass).map((c) => c.name),
			})),
		},
		ms: produced.reduce((a, p) => a + p.ms, 0),
	});
	console.error(`${detected ? "ok  " : "FAIL"} MUT-${spec.id} detected=${detected}`);
}

async function main(): Promise<number> {
	const watchdog = setTimeout(async () => {
		console.error("WATCHDOG: exceeded wall-clock budget, cleaning up");
		await cleanupAll();
		process.exit(3);
	}, WATCHDOG_MS);
	const onSignal = async () => {
		await cleanupAll();
		process.exit(130);
	};
	process.on("SIGINT", onSignal);
	process.on("SIGTERM", onSignal);

	const daemonDir = join(REPO, "platform", "daemon");
	let exitCode = 0;
	try {
		await step(
			"P00-preflight",
			"Pinned implementation source guard, runtime versions, no live-daemon contact",
			async (s) => {
				const head = git(["rev-parse", "HEAD"]);
				const isAncestor =
					Bun.spawnSync(["git", "merge-base", "--is-ancestor", PINNED_SHA, "HEAD"], { cwd: REPO }).exitCode === 0;
				s.check("pinned implementation SHA is an ancestor of HEAD", isAncestor, { pinned: PINNED_SHA, head });
				s.check(
					"merge-base with pinned base is the base SHA",
					git(["merge-base", BASE_SHA, "HEAD"]) === BASE_SHA,
					git(["merge-base", BASE_SHA, "HEAD"]),
				);
				const changed = new Set<string>(
					[
						...git(["diff", "--name-only", PINNED_SHA]).split("\n"),
						...git(["ls-files", "--others", "--exclude-standard"]).split("\n"),
					].filter((x) => x),
				);
				const PROD = /^(platform|libs|integrations|surfaces)\//;
				const TESTLIKE = /(\.test\.|\.spec\.|\/__tests__\/|\/test\/|\/tests\/)/;
				const PKG = /(^|\/)(package\.json|bun\.lock|bun\.lockb|package-lock\.json|pnpm-lock\.yaml)$/;
				const driftedProduction = [...changed].filter((p) => (PROD.test(p) && !TESTLIKE.test(p)) || PKG.test(p)).sort();
				s.check(
					"production sources and package/lock files are byte-identical to the pinned implementation",
					driftedProduction.length === 0,
					driftedProduction,
				);
				s.obs("changed_vs_pin_allowed", [...changed].filter((p) => !driftedProduction.includes(p)).sort());
				const untracked = git(["status", "--porcelain"])
					.split("\n")
					.filter((l) => l.startsWith("??"));
				s.obs("untracked_path_count", untracked.length);
				s.check(
					"workspace scratch path is not the user's real ~/.agents",
					!scratchBase().includes(".agents"),
					redact(scratchBase()),
				);
				s.check(
					"core dist includes migration 171 board tables",
					readFileSync(join(REPO, "platform", "core", "dist", "index.js"), "utf8").includes("board_threads"),
					null,
				);
				const bunVersion = Bun.version;
				const nodeVersion = Bun.spawnSync(["node", "--version"]).stdout.toString().trim();
				s.obs("runtime", {
					bun: bunVersion,
					node: nodeVersion,
					os: `${process.platform} ${release()} ${arch()}`,
					sqlite: Bun.spawnSync(["sqlite3", "--version"]).stdout.toString().trim().split(" ")[0],
				});
				s.obs("pinned", { implementation_pin: PINNED_SHA, current_head: head, base: BASE_SHA });
				s.obs(
					"script_sha256",
					createHash("sha256")
						.update(readFileSync(import.meta.path))
						.digest("hex"),
				);
				s.obs("assumptions", [
					"daemon started from source via `bun src/daemon.ts` in platform/daemon (documented isolated-daemon path), not the installed binary",
					"HOME, TMPDIR and SIGNET_PATH point at a per-run scratch dir; telemetry opt-out set; embedding provider none; pipeline and dreaming disabled; no inference target configured, so no LLM or network inference is possible",
					"local-mode daemon trusts all loopback callers; token-scope claims are therefore proved only against a separate team-mode daemon",
					"agent identity in local mode is self-declared; read-policy filtering is not a security boundary (per docs)",
				]);
			},
		);

		const preflightPassed = steps.find((entry) => entry.id === "P00-preflight")?.status === "pass";
		if (preflightPassed && !ONLY_MUTATION) {
			const port = await freePort();
			const wsInfo = makeWorkspace("local", "local", port);
			const holder = { daemon: null as unknown as Daemon };
			await step(
				"L00-boot-local-daemon",
				"Initialise scratch DB and start the source daemon on a dynamic loopback port",
				async (s) => {
					initDb(wsInfo, daemonDir);
					holder.daemon = await boot(wsInfo, daemonDir, "local", s);
					s.obs("port", wsInfo.port);
					s.obs("daemon_pid", holder.daemon.pid);
				},
			);
			if (holder.daemon) {
				await localScenario("full", wsInfo, holder);
				await agentPurgeObservation(wsInfo, holder);
				await restartScenario(wsInfo, holder);
				const tail = redact(tailLog(holder.daemon.logPath, 100_000));
				const errors = tail
					.split("\n")
					.filter((line) => /\bERROR\b|\bFATAL\b|Unhandled|uncaught/i.test(line))
					.slice(-20);
				await step(
					"L12-daemon-log-error-scan",
					"Daemon log after the full run has no ERROR/FATAL/unhandled lines",
					async (s) => {
						s.obs("error_lines", errors);
						s.check("zero ERROR/FATAL/unhandled lines in the final daemon log", errors.length === 0, errors);
					},
				);
				await stopDaemon(holder.daemon, "graceful");
			}
			await teamScenario(daemonDir);
		}

		if (preflightPassed && !SKIP_MUTATION) {
			for (const spec of MUTATIONS) {
				if (ONLY_MUTATION && spec.id !== ONLY_MUTATION) continue;
				await mutationControl(spec);
			}
		}

		notVerified(
			"N01-real-harness-wake",
			"Real Claude Code/Codex/Pi harness consuming a wake",
			"not exercised: requires a separately configured host session; this runner drives the HTTP wake endpoint, not actual host execution",
		);
		notVerified(
			"N02-mcp-tools",
			"MCP board_* tools and agent_message_* tools",
			"not exercised by this script (HTTP routes only)",
		);
		notVerified("N03-dashboard", "Dashboard Board view", "not exercised by this script (no browser)");
		notVerified(
			"N04-dreaming-extraction",
			"Dreaming consumption of board_post artifacts",
			"covered separately by the Dreaming characterization; this script observes projection rows and their removal",
		);
		notVerified(
			"N05-sources-api-purge",
			"DELETE /api/sources/:id purge of board_post artifacts",
			"board projections are not a configured source; thread delete is the only purge path exercised (L10)",
		);
	} finally {
		clearTimeout(watchdog);
		await cleanupAll();
	}
	if (!KEEP) {
		await step("Z00-cleanup", "Scratch directories and daemon processes are gone after the run", async (s) => {
			const dirsLeft = scratchRoots.filter((root) => existsSync(root));
			const survivors = scratchRoots.flatMap((root) => envOwners(root));
			s.check("no scratch directory remains", dirsLeft.length === 0, dirsLeft.map(redact));
			s.check("no process still carries a scratch-root environment", survivors.length === 0, survivors);
			s.obs("scratch_roots_created", scratchRoots.length);
		});
	}

	const failed = steps.filter((x) => x.status === "fail");
	const report = {
		verdict: failed.length === 0 ? "PASS" : "FAIL",
		implementation_pin_sha: PINNED_SHA,
		current_head_sha: git(["rev-parse", "HEAD"]),
		sql_inspection: {
			method: "frozen-process-group byte-copy snapshot; original DB never opened by harness",
			snapshots: snapshotStats.taken,
			unsafe_or_failed: snapshotStats.unsafe,
			max_freeze_ms: Math.max(0, ...snapshotStats.frozen_ms),
		},
		base_sha: BASE_SHA,
		pr: 2181,
		command: `bun scripts/verification/agent-message-board-runtime.ts${process.argv.slice(2).length ? ` ${process.argv.slice(2).join(" ")}` : ""}`,
		run: { started_at: STARTED_AT, finished_at: new Date().toISOString() },
		summary: {
			steps: steps.length,
			pass: steps.filter((x) => x.status === "pass").length,
			fail: failed.length,
			observation: steps.filter((x) => x.status === "observation").length,
			not_verified: steps.filter((x) => x.status === "not_verified").length,
			checks: steps.reduce((a, x) => a + x.checks.length, 0),
			checks_failed: steps.reduce((a, x) => a + x.checks.filter((c) => !c.pass).length, 0),
		},
		failed_steps: failed.map((x) => ({ id: x.id, failed_checks: x.checks.filter((c) => !c.pass).map((c) => c.name) })),
		steps,
		scratch_cleanup: KEEP ? "kept (--keep-workspace)" : "verified by Z00-cleanup",
	};
	const text = redact(JSON.stringify(sortKeys(report), null, 2));
	mkdirSync(OUT_DIR, { recursive: true });
	const file = join(OUT_DIR, ONLY_MUTATION ? `report-${ONLY_MUTATION}.json` : "report.json");
	writeFileSync(file, `${text}\n`);
	console.log(text);
	exitCode = failed.length === 0 ? 0 : 1;
	return exitCode;
}

const code = await main();
process.exit(code);
