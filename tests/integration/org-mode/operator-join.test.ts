import { expect, test } from "bun:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { buildHermeticEnvironment } from "../../../scripts/run-hermetic-tests";
import { OrgDaemon, repo } from "./daemon";
import { Fixture } from "./fixture";
import { request, success } from "./http";

test("live setup --join approves a dynamic-port instance without creating a local workspace", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.createIdentity(daemon);
		const root = join(daemon.root, "joining-client");
		await mkdir(root);
		const env: NodeJS.ProcessEnv = {
			...buildHermeticEnvironment({ PATH: process.env.PATH }, root),
			SIGNET_PATH: join(root, "untouched-workspace"),
			SIGNET_DAEMON_URL: daemon.origin,
			SIGNET_PORT: String(daemon.port),
			DBUS_SESSION_BUS_ADDRESS: `unix:path=${root}/no-bus`,
		};
		const sentinel = join(root, "personal-instructions.md");
		await writeFile(sentinel, "Keep personal instructions\n");
		const child = Bun.spawn(
			[
				process.execPath,
				join(repo, "surfaces/cli/src/cli.ts"),
				"--json",
				"setup",
				"--join",
				daemon.origin,
				"--device-code",
			],
			{
				cwd: repo,
				env,
				stdout: "pipe",
				stderr: "pipe",
				timeout: 30_000,
			},
		);
		let stderr = "";
		let approved = false;
		const approval = (async () => {
			const reader = child.stderr.getReader();
			for (;;) {
				const chunk = await reader.read();
				if (chunk.done) break;
				stderr += new TextDecoder().decode(chunk.value);
				const code = /Enter code: ([A-Z0-9-]+)/.exec(stderr)?.[1];
				if (code && !approved) {
					approved = true;
					success(
						await request(daemon.origin, "/api/auth/device/approve", fixture.admin, "POST", {
							userCode: code,
							decision: "approve",
						}),
						"approve setup join",
					);
				}
			}
		})();
		const [stdout, code] = await Promise.all([new Response(child.stdout).text(), child.exited]);
		await approval;
		expect(approved, stderr).toBe(true);
		expect(code, stderr).toBe(0);
		expect(JSON.parse(stdout)).toMatchObject({ authenticated: true, url: daemon.origin });
		expect(await Bun.file(join(root, "untouched-workspace/agent.yaml")).exists()).toBe(false);
		expect(await Bun.file(join(env.HOME ?? root, ".agents/agent.yaml")).exists()).toBe(false);
		expect(await readFile(sentinel, "utf8")).toBe("Keep personal instructions\n");
		expect(success(await request(daemon.origin, "/health"), "host survived join").agentsDir).toBe(daemon.workspace);
	} finally {
		await daemon.dispose();
	}
}, 60_000);
