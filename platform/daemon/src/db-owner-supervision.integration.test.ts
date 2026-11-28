import { expect, test } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { Database } from "bun:sqlite";
import { z } from "zod";

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No test port");
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return address.port;
}

async function launchFixture(root: string, entrypoint: string, budgetMs: number) {
	const port = await unusedPort();
	const endpoint = `http://127.0.0.1:${port}`;
	const env: NodeJS.ProcessEnv = {
		...process.env,
		HOME: join(root, "home"),
		SIGNET_PATH: join(root, "workspace"),
		SIGNET_WORKSPACE: join(root, "workspace"),
		SIGNET_PORT: String(port),
		SIGNET_HOST: "127.0.0.1",
		SIGNET_BIND: "127.0.0.1",
		SIGNET_DAEMON_URL: endpoint,
		SIGNET_DAEMON_ENTRYPOINT: "1",
		SIGNET_TELEMETRY_OPTOUT: "1",
	};
	delete env.HERMES_HOME;
	delete env.CODEX_HOME;
	const child = spawn(process.execPath, [join(import.meta.dir, "__tests__", entrypoint)], {
		env,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	let exited = false;
	const kill = (): void => {
		if (child.pid === undefined) return;
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
		}
	};
	const watchdog = setTimeout(kill, budgetMs);
	const capture = (chunk: Buffer): void => {
		output += chunk.toString();
		if (output.includes("SUPERVISION_FAILURE")) kill();
	};
	child.stdout.on("data", capture);
	child.stderr.on("data", capture);
	const exit = new Promise<number | null>((resolve) =>
		child.on("close", (code) => {
			exited = true;
			resolve(code);
		}),
	);
	return {
		child,
		endpoint,
		exit,
		output: () => output,
		exited: () => exited,
		close: async () => {
			clearTimeout(watchdog);
			kill();
			await exit;
			rmSync(root, { recursive: true, force: true });
		},
	};
}

test("real daemon retires runaway owners, recovers reads and rolls back partial writes", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-supervision-"));
	const fixture = await launchFixture(root, "owner-supervision-daemon.ts", 15000);
	try {
		expect(await fixture.exit, fixture.output()).toBe(0);
		const line = fixture
			.output()
			.split("\n")
			.find((line) => line.startsWith("SUPERVISION_RESULT "));
		expect(line, fixture.output()).toBeDefined();
		const database = new Database(join(root, "workspace", "data", "signet.db"), { readonly: true });
		try {
			expect(database.query("SELECT * FROM supervision_writes").all()).toEqual([]);
			expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		} finally {
			database.close();
		}
	} finally {
		await fixture.close();
	}
}, 20000);

const startupHealth = z.object({
	status: z.string(),
	pid: z.number(),
	agentsDir: z.string(),
	db: z.boolean(),
	dbOwner: z
		.object({
			pid: z.number().nullable(),
			migration: z.object({ version: z.number(), completedOperations: z.number() }).nullable().optional(),
		})
		.nullable(),
});
for (const stalled of [false, true]) {
	test(
		`real daemon migration ${stalled ? "stalls once with a typed failure" : "progresses past 60 seconds before readiness"}`,
		async () => {
			const root = mkdtempSync(join(tmpdir(), stalled ? "signet-stalled-" : "signet-progressing-"));
			const fixture = await launchFixture(root, "migration-startup-daemon.ts", stalled ? 40000 : 80000);
			const started = Date.now();
			let ready = false;
			let statusChecked = false;
			let progressedAfterStartupBudget = false;
			const operations = new Set<number>();
			const ownerPids = new Set<number>();
			try {
				while (!fixture.exited()) {
					let response: Response;
					try {
						response = await fetch(`${fixture.endpoint}/health`, { signal: AbortSignal.timeout(500) });
					} catch {
						await Bun.sleep(100);
						continue;
					}
					const health = startupHealth.parse(await response.json());
					expect(health.pid).toBe(fixture.child.pid);
					expect(health.agentsDir).toBe(join(root, "workspace"));
					if (health.status === "migrating") {
						expect(health.db).toBe(false);
						expect(health.dbOwner?.migration?.version).toBe(183);
						const operation = health.dbOwner?.migration?.completedOperations;
						if (operation !== undefined) operations.add(operation);
						const pid = health.dbOwner?.pid;
						if (pid !== null && pid !== undefined) ownerPids.add(pid);
						if (Date.now() - started > 60000) progressedAfterStartupBudget = true;
						if (!statusChecked) {
							const status = startupHealth.parse(await (await fetch(`${fixture.endpoint}/api/status`)).json());
							expect(status.status).toBe("migrating");
							expect(status.dbOwner?.migration?.version).toBe(183);
							expect((await fetch(`${fixture.endpoint}/health/ready`)).status).toBe(503);
							expect(
								(await fetch(`${fixture.endpoint}/api/memory/remember`, { method: "POST", body: "{}" })).status,
							).toBe(503);
							statusChecked = true;
						}
					}
					if (health.status === "healthy") {
						ready = true;
						break;
					}
					await Bun.sleep(100);
				}
				if (stalled) {
					expect(await fixture.exit, fixture.output()).toBe(1);
					expect(fixture.output()).toContain("DB_OWNER_MIGRATION_STALLED");
					expect(readdirSync(join(root, "workspace", "data")).some((name) => name.startsWith("signet.db.bak-v"))).toBe(
						true,
					);
					expect(ready).toBe(false);
				} else {
					expect(ready, fixture.output()).toBe(true);
					expect(progressedAfterStartupBudget).toBe(true);
					expect(operations.size).toBeGreaterThan(10);
					fixture.child.kill("SIGTERM");
					expect(await fixture.exit, fixture.output()).toBe(0);
				}
				expect(statusChecked).toBe(true);
				expect(ownerPids.size).toBe(1);
				const database = new Database(join(root, "workspace", "data", "signet.db"), { readonly: true });
				try {
					expect(database.query("SELECT version FROM schema_migrations WHERE version=183").get()).toEqual(
						stalled ? null : { version: 183 },
					);
					if (stalled)
						expect(
							database.query("SELECT name FROM sqlite_master WHERE name='migration_fixture_rows'").get(),
						).toBeNull();
					else expect(database.query("SELECT COUNT(*) n FROM migration_fixture_rows").get()).toEqual({ n: 130 });
					expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
				} finally {
					database.close();
				}
			} finally {
				await fixture.close();
			}
		},
		stalled ? 45000 : 90000,
	);
}
