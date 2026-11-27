import { beforeAll, expect, test } from "bun:test";
import { join } from "node:path";
import { readFile, stat, rm, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { buildHermeticEnvironment } from "../../../scripts/run-hermetic-tests";
import { repo, reservePort, terminateOwnedGroup } from "./daemon";
import { browser, request, success } from "./http";
import { resolveWorkspaceLayout } from "../../../platform/core/src/workspace-layout";

beforeAll(async () => {
	const build = Bun.spawn([process.execPath, "build.ts"], {
		cwd: join(repo, "platform/daemon"),
		stdout: "pipe",
		stderr: "pipe",
	});
	const [, stderr, code] = await Promise.all([
		new Response(build.stdout).text(),
		new Response(build.stderr).text(),
		build.exited,
	]);
	expect(code, stderr).toBe(0);
}, 60_000);

async function cli(env: NodeJS.ProcessEnv, args: string[]) {
	const child = Bun.spawn([process.execPath, join(repo, "surfaces/cli/src/cli.ts"), ...args], {
		cwd: repo,
		env,
		stdout: "pipe",
		stderr: "pipe",
		timeout: 75_000,
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}

test("standalone host setup refuses an occupied port before creating or launching a workspace", async () => {
	const root = await mkdtemp(join(tmpdir(), "signet-host-busy-"));
	const workspace = join(root, "workspace");
	const listener = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json({ agentsDir: workspace, pid: process.pid }),
	});
	try {
		const origin = `http://127.0.0.1:${listener.port}`;
		const env = {
			...buildHermeticEnvironment({ PATH: process.env.PATH }, root),
			SIGNET_PATH: workspace,
			SIGNET_PORT: String(listener.port),
			SIGNET_DAEMON_URL: origin,
		};
		for (const flags of [[], ["--port", String(listener.port)]]) {
			const result = await cli(env, ["setup", "--host", "--public-url", origin, ...flags]);
			expect(result.code).not.toBe(0);
			expect(result.stderr).toContain(String(listener.port));
			expect(result.stderr).toContain("--port");
			expect(result.stdout).not.toContain("Setup URL:");
			expect(await Bun.file(join(workspace, "agent.yaml")).exists()).toBe(false);
			expect(await Bun.file(join(resolveWorkspaceLayout(workspace).runtime, "pid")).exists()).toBe(false);
		}
	} finally {
		await listener.stop(true);
		await rm(root, { recursive: true, force: true });
	}
}, 20_000);

for (const selection of ["flag", "environment", "url"] as const) {
	test(`standalone host setup launches, claims and verifies its own daemon using ${selection} port precedence`, async () => {
		const root = await mkdtemp(join(tmpdir(), "signet-host-standalone-"));
		const workspace = join(root, "workspace");
		const port = await reservePort();
		const origin = `http://127.0.0.1:${port}`;
		const other = Bun.serve({
			hostname: "127.0.0.1",
			port: 0,
			fetch: () => Response.json({ agentsDir: "wrong-workspace", pid: process.pid }),
		});
		const env: NodeJS.ProcessEnv = {
			...buildHermeticEnvironment({ PATH: process.env.PATH }, root),
			SIGNET_PATH: workspace,
			SIGNET_DAEMON_URL: selection === "url" ? origin : `http://127.0.0.1:${other.port}`,
			SIGNET_HOST: "127.0.0.1",
			SIGNET_BIND: "127.0.0.1",
			SIGNET_TELEMETRY_OPTOUT: "1",
			SIGNET_ANALYTICS_DISABLED: "1",
			SIGNET_EMBEDDING_WARM_NATIVE: "false",
			SIGNET_DAEMON_RUNTIME: "bun-js",
			SIGNET_DAEMON_JS_PATH: join(repo, "platform/daemon/dist/daemon.js"),
			DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/no-user-bus`,
		};
		if (selection !== "url") env.SIGNET_PORT = String(selection === "flag" ? other.port : port);
		const pidPath = () => join(resolveWorkspaceLayout(workspace).runtime, "pid");
		try {
			const result = await cli(env, [
				"setup",
				"--host",
				...(selection === "flag" ? ["--port", String(port)] : ["--public-url", origin]),
			]);
			expect(result.code, result.stderr).toBe(0);
			expect(result.stdout).toContain(`Daemon: ${origin}`);
			expect(result.stdout).toContain(`Setup URL: ${origin}/auth/setup`);
			const pid = Number((await readFile(pidPath(), "utf8")).trim());
			expect(Number.isSafeInteger(pid) && pid > 0).toBe(true);
			const health = success(await request(origin, "/health"), "host readiness");
			expect(health).toMatchObject({ pid, agentsDir: workspace });
			const config = await readFile(join(workspace, "agent.yaml"), "utf8");
			expect(config).toContain("mode: team");
			const tokenPath = join(resolveWorkspaceLayout(workspace).runtime, "setup-token");
			const token = (await readFile(tokenPath, "utf8")).trim();
			expect(result.stdout.includes(token)).toBe(true);
			expect((await stat(tokenPath)).mode & 0o777).toBe(0o600);
			const claim = await request(origin, "/api/org/claim", {}, "POST", {
				setupToken: token,
				organizationName: "Standalone host",
				admin: { username: "host-admin", displayName: "Host admin", password: "isolated host password" },
			});
			success(claim, "standalone organization claim");
			expect(success(await request(origin, "/api/org/settings", browser(claim)), "host settings").publicUrl).toBe(
				origin,
			);
			expect(success(await request(origin, "/health"), "claimed health")).toMatchObject({ pid, agentsDir: workspace });
			const joiner = await cli(env, ["setup", "--join", origin, "--non-interactive", "--device-code"]);
			expect(joiner.code).toBe(1);
			expect(joiner.stdout).toBe("");
			expect(joiner.stderr.toLowerCase()).toContain("interactive");
			expect(success(await request(origin, "/health"), "join leaves host unchanged").pid).toBe(pid);
		} finally {
			if (await Bun.file(pidPath()).exists()) {
				const pid = Number((await readFile(pidPath(), "utf8")).trim());
				if (Number.isSafeInteger(pid) && pid > 0) await terminateOwnedGroup(pid);
			}
			await other.stop(true);
			await rm(root, { recursive: true, force: true });
		}
	}, 90_000);
}
