import { expect, test, spyOn } from "bun:test";
import { join } from "node:path";
import { access, readFile, stat, rm } from "node:fs/promises";
import { OrgDaemon, repo } from "./daemon";
import { browser, request, success } from "./http";
import { resolveWorkspaceLayout } from "../../../platform/core/src/workspace-layout";

test("fresh organization host bootstraps a team database before its real daemon starts", async () => {
	const daemon = await OrgDaemon.create();
	const print = spyOn(console, "log").mockImplementation(() => {});
	try {
		await daemon.stop();
		await rm(daemon.workspace, { recursive: true, force: true });
		const { setupOrganizationHost } = await import("../../../surfaces/cli/src/features/setup-organization");
		await setupOrganizationHost(
			{
				host: true,
				publicUrl: daemon.origin,
				bootstrapUrl: daemon.origin,
				path: daemon.workspace,
				nonInteractive: true,
			},
			{
				AGENTS_DIR: daemon.workspace,
				DEFAULT_PORT: daemon.port,
				normalizeAgentPath: (value) => value,
				getTemplatesDir: () => join(repo, "surfaces/cli/templates"),
				startDaemon: async () => {
					await daemon.start();
					return true;
				},
			},
		);
		const config = await readFile(join(daemon.workspace, "agent.yaml"), "utf8");
		expect(config).toContain("mode: team");
		expect((await request(daemon.origin, "/api/auth/methods")).status).toBe(200);
		const token = await daemon.setupToken();
		expect(daemon.stdout.includes(token)).toBe(false);
	} finally {
		print.mockRestore();
		await daemon.dispose();
	}
}, 90_000);

test("headless host setup verifies its public URL without leaking the setup nonce to daemon logs", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const env = { ...daemon.env };
		delete env.SIGNET_DAEMON_ENTRYPOINT;
		const child = Bun.spawn(
			[
				process.execPath,
				join(repo, "surfaces/cli/src/cli.ts"),
				"setup",
				"--host",
				"--local",
				"--public-url",
				daemon.origin,
				"--path",
				daemon.workspace,
			],
			{ env, stdout: "pipe", stderr: "pipe" },
		);
		const [stdout, stderr, code] = await Promise.all([
			new Response(child.stdout).text(),
			new Response(child.stderr).text(),
			child.exited,
		]);
		expect(code, stderr).toBe(0);
		const token = await daemon.setupToken();
		expect(stdout.includes(token)).toBe(true);
		expect(daemon.stdout.includes(token)).toBe(false);
		expect(daemon.stderr.includes(token)).toBe(false);
		const file = join(resolveWorkspaceLayout(daemon.workspace).runtime, "setup-token");
		expect((await stat(file)).mode & 0o777).toBe(0o600);
		const claimed = await request(daemon.origin, "/api/org/claim", {}, "POST", {
			setupToken: token,
			organizationName: "Hosted",
			admin: { username: "host-admin", displayName: "Host admin", password: "isolated host password" },
		});
		success(claimed, "claim hosted organization");
		expect(
			success(await request(daemon.origin, "/api/org/settings", browser(claimed)), "host settings").publicUrl,
		).toBe(daemon.origin);
		const joiner = Bun.spawn(
			[
				process.execPath,
				join(repo, "surfaces/cli/src/cli.ts"),
				"setup",
				"--join",
				daemon.origin,
				"--non-interactive",
				"--device-code",
			],
			{ env, stdout: "pipe", stderr: "pipe" },
		);
		const [joinOutput, joinError, joinCode] = await Promise.all([
			new Response(joiner.stdout).text(),
			new Response(joiner.stderr).text(),
			joiner.exited,
		]);
		expect(joinCode).toBe(1);
		expect(joinOutput).toBe("");
		expect(joinError.toLowerCase()).toContain("interactive");
		let localWorkspace = false;
		try {
			await access(join(daemon.home, ".agents"));
			localWorkspace = true;
		} catch (error) {
			if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
		}
		expect(localWorkspace).toBe(false);
	} finally {
		await daemon.dispose();
	}
}, 60_000);
