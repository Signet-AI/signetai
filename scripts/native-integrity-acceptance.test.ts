/**
 * Compiled release acceptance for the owner-routed operator integrity path.
 *
 * The fixture is intentionally large enough to keep both global SQLite checks
 * in flight while the probe polls /health/live. The test is opt-in because it
 * writes a sizeable disposable database and is run by native acceptance CI.
 */
import { Database } from "bun:sqlite";
import { afterEach, describe, expect, test } from "bun:test";
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const root = join(import.meta.dir, "..");
const enabled = process.env.SIGNET_NATIVE_INTEGRITY_SMOKE === "1";
const DEFAULT_FIXTURE_ROWS = 500_000;
let smokeHome: string | null = null;
let daemonChild: ChildProcess | null = null;

function nativeSmokeBinary(): string {
	const override = process.env.SIGNET_NATIVE_SMOKE_BINARY;
	if (override) return resolve(root, override);
	const key = `${process.platform}-${process.arch}`;
	return join(root, "dist", "native", key.startsWith("win32-") ? `signet-${key}.exe` : `signet-${key}`);
}

function smokeEnv(home: string, workspace: string): NodeJS.ProcessEnv {
	return {
		...process.env,
		HOME: home,
		XDG_CONFIG_HOME: join(home, ".config"),
		SIGNET_PATH: workspace,
		SIGNET_TELEMETRY_ENABLED: "false",
		SIGNET_TELEMETRY_OPTOUT: "1",
		NO_COLOR: "1",
	};
}

function run(binary: string, args: readonly string[], env: NodeJS.ProcessEnv, timeout: number): string {
	const result = spawnSync(binary, [...args], { env, encoding: "utf8", timeout });
	const output = `${result.stdout ?? ""}${result.stderr ?? ""}`;
	if (result.error) throw new Error(`${binary} ${args.join(" ")} failed: ${result.error.message}\n${output}`);
	if (result.status !== 0) throw new Error(`${binary} ${args.join(" ")} exited ${result.status}\n${output}`);
	return output;
}

async function freePort(): Promise<number> {
	const server = Bun.serve({ port: 0, fetch: () => new Response("ok") });
	const port = server.port;
	await server.stop(true);
	return port;
}

async function waitForHealth(origin: string, child: ChildProcess, output: () => string): Promise<void> {
	const deadline = Date.now() + 90_000;
	while (Date.now() < deadline) {
		if (child.exitCode !== null) throw new Error(`native daemon exited ${child.exitCode}\n${output()}`);
		try {
			const response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1_000) });
			if (response.ok) return;
		} catch {}
		await Bun.sleep(100);
	}
	throw new Error(`native daemon did not become healthy\n${output()}`);
}

async function stopDaemonChild(): Promise<void> {
	const child = daemonChild;
	daemonChild = null;
	if (child === null || child.exitCode !== null) return;
	await new Promise<void>((resolveClose) => {
		let settled = false;
		const finish = (): void => {
			if (settled) return;
			settled = true;
			resolveClose();
		};
		child.once("close", finish);
		child.kill("SIGTERM");
		setTimeout(() => {
			if (child.exitCode === null) child.kill("SIGKILL");
			finish();
		}, 5_000);
	});
}

function seedIntegrityFixture(workspace: string): number {
	const requested = Number(process.env.SIGNET_NATIVE_INTEGRITY_ROWS ?? DEFAULT_FIXTURE_ROWS);
	const rows = Number.isInteger(requested) && requested > 0 ? Math.min(requested, 2_000_000) : DEFAULT_FIXTURE_ROWS;
	const database = new Database(join(workspace, "memory", "memories.db"));
	try {
		database.exec("PRAGMA busy_timeout = 10000");
		database.exec(
			"CREATE TABLE IF NOT EXISTS integrity_acceptance_fixture (id INTEGER PRIMARY KEY, payload TEXT NOT NULL)",
		);
		database.exec("DELETE FROM integrity_acceptance_fixture");
		const insert = database.prepare("INSERT INTO integrity_acceptance_fixture (id, payload) VALUES (?, ?)");
		const payload = "owner-routed-integrity-acceptance".repeat(4);
		database.exec("BEGIN IMMEDIATE");
		try {
			for (let id = 1; id <= rows; id += 1) insert.run(id, payload);
			database.exec("COMMIT");
		} catch (error) {
			database.exec("ROLLBACK");
			throw error;
		}
		return rows;
	} finally {
		database.close();
	}
}

afterEach(async () => {
	await stopDaemonChild();
	if (smokeHome === null) return;
	rmSync(smokeHome, { recursive: true, force: true });
	smokeHome = null;
});

describe("compiled native operator integrity", () => {
	const smoke = enabled ? test : test.skip;

	smoke(
		"keeps /health/live responsive during the largest supported integrity fixture",
		async () => {
			const binary = nativeSmokeBinary();
			if (!existsSync(binary)) {
				throw new Error(`native binary not found at ${binary}; build it first (bun run build:native-bun)`);
			}
			smokeHome = mkdtempSync(join(tmpdir(), "signet-native-integrity-"));
			const workspace = join(smokeHome, ".agents");
			const port = await freePort();
			const origin = `http://127.0.0.1:${port}`;
			const env = smokeEnv(smokeHome, workspace);

			run(
				binary,
				[
					"setup",
					"--non-interactive",
					"--path",
					workspace,
					"--name",
					"Native Integrity Acceptance",
					"--identity-mode",
					"managed",
					"--identity-preset",
					"minimal",
					"--network-mode",
					"localhost",
					"--remote-url",
					origin,
					"--embedding-provider",
					"none",
					"--extraction-provider",
					"none",
					"--skip-git",
					"--disable-signet-secrets",
					"--disable-graphiq",
				],
				env,
				120_000,
			);

			let daemonOutput = "";
			daemonChild = spawn(binary, [], {
				env: {
					...env,
					SIGNET_DAEMON_ENTRYPOINT: "1",
					SIGNET_PORT: String(port),
					SIGNET_BIND: "127.0.0.1",
					SIGNET_SKIP_AGENT_REGISTER: "1",
				},
				stdio: ["ignore", "pipe", "pipe"],
			});
			daemonChild.stdout?.setEncoding("utf8");
			daemonChild.stderr?.setEncoding("utf8");
			daemonChild.stdout?.on("data", (chunk: string) => {
				daemonOutput += chunk;
			});
			daemonChild.stderr?.on("data", (chunk: string) => {
				daemonOutput += chunk;
			});
			await waitForHealth(origin, daemonChild, () => daemonOutput);

			const rows = seedIntegrityFixture(workspace);
			const integrityResponsePromise = fetch(`${origin}/api/repair/integrity-check`, {
				signal: AbortSignal.timeout(120_000),
			});
			let integritySettled = false;
			const observedResponse = integrityResponsePromise.finally(() => {
				integritySettled = true;
			});
			let liveResponses = 0;
			const pollDeadline = Date.now() + 120_000;
			while (!integritySettled && Date.now() < pollDeadline) {
				try {
					const live = await fetch(`${origin}/health/live`, { signal: AbortSignal.timeout(2_000) });
					if (live.ok) liveResponses += 1;
				} catch {}
				await Bun.sleep(20);
			}

			const response = await observedResponse;
			const body = (await response.json()) as {
				ok?: unknown;
				outcome?: unknown;
				executionHome?: unknown;
				quickCheck?: { ok?: unknown };
				fullCheck?: { ok?: unknown };
			};
			expect(response.ok).toBe(true);
			expect(body).toMatchObject({
				ok: true,
				outcome: "passed",
				executionHome: "db-owner.verify",
				quickCheck: { ok: true },
				fullCheck: { ok: true },
			});
			expect(liveResponses).toBeGreaterThan(0);
			expect(rows).toBeGreaterThan(0);
		},
		3 * 60_000,
	);
});
