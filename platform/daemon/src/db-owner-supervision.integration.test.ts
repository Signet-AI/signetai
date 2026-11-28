import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { Database } from "bun:sqlite";

async function unusedPort(): Promise<number> {
	const server = createServer();
	await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("No test port");
	await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
	return address.port;
}

test("real daemon retires runaway owners, recovers reads and rolls back partial writes", async () => {
	const root = mkdtempSync(join(tmpdir(), "signet-supervision-"));
	const port = await unusedPort();
	const env = {
		...process.env,
		HOME: join(root, "home"),
		SIGNET_PATH: join(root, "workspace"),
		SIGNET_WORKSPACE: join(root, "workspace"),
		SIGNET_PORT: String(port),
		SIGNET_HOST: "127.0.0.1",
		SIGNET_BIND: "127.0.0.1",
		SIGNET_DAEMON_URL: `http://127.0.0.1:${port}`,
		SIGNET_DAEMON_ENTRYPOINT: "1",
		SIGNET_TELEMETRY_OPTOUT: "1",
	};
	delete env.HERMES_HOME;
	delete env.CODEX_HOME;
	const child = spawn(process.execPath, [join(import.meta.dir, "test-support", "owner-supervision-daemon.ts")], {
		env,
		detached: true,
		stdio: ["ignore", "pipe", "pipe"],
	});
	let output = "";
	const kill = (): void => {
		if (child.pid === undefined) return;
		try {
			process.kill(-child.pid, "SIGKILL");
		} catch (error) {
			if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
		}
	};
	const watchdog = setTimeout(kill, 15000);
	const capture = (chunk: Buffer): void => {
		output += chunk.toString();
		if (output.includes("SUPERVISION_FAILURE")) kill();
	};
	child.stdout.on("data", capture);
	child.stderr.on("data", capture);
	const exit = new Promise<number | null>((resolve) => child.on("close", resolve));
	try {
		expect(await exit, output).toBe(0);
		const line = output.split("\n").find((line) => line.startsWith("SUPERVISION_RESULT "));
		expect(line, output).toBeDefined();
		const database = new Database(join(root, "workspace", "data", "signet.db"), { readonly: true });
		try {
			expect(database.query("SELECT * FROM supervision_writes").all()).toEqual([]);
			expect(database.query("PRAGMA integrity_check").get()).toEqual({ integrity_check: "ok" });
		} finally {
			database.close();
		}
	} finally {
		clearTimeout(watchdog);
		kill();
		await exit;
		rmSync(root, { recursive: true, force: true });
	}
}, 20000);
