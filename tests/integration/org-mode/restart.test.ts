import { expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { resolveWorkspaceLayout } from "../../../platform/core/src/workspace-layout";
import { OrgDaemon, repo } from "./daemon";
import { Fixture, device } from "./fixture";
import { record, request, success, text, until } from "./http";

async function systemctl(args: readonly string[]) {
	const child = Bun.spawn(["systemctl", "--user", ...args], {
		stdout: "pipe",
		stderr: "pipe",
		env: { ...process.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}` },
	});
	const [stdout, stderr, code] = await Promise.all([
		new Response(child.stdout).text(),
		new Response(child.stderr).text(),
		child.exited,
	]);
	return { stdout, stderr, code };
}
test.skipIf(process.env.SIGNET_TEST_SYSTEMD !== "1")(
	"verified systemd restart returns only after durable ready completion",
	async () => {
		const daemon = await OrgDaemon.create();
		const unit = `signet-org-l7-${randomUUID()}.service`;
		let owned = false;
		try {
			const fixture = await Fixture.create(daemon, "personal", false);
			const admin = await device(daemon, fixture.admin, "supervised-cli");
			await daemon.stop();
			const env = { ...daemon.env, XDG_RUNTIME_DIR: `/run/user/${process.getuid?.()}` };
			const launch = Bun.spawn(
				[
					"systemd-run",
					"--user",
					"--collect",
					`--unit=${unit}`,
					"--property=Type=forking",
					`--property=PIDFile=${join(resolveWorkspaceLayout(daemon.workspace).runtime, "pid")}`,
					"--property=Restart=always",
					"--property=TimeoutStopSec=25s",
					`--working-directory=${join(repo, "platform/daemon")}`,
					"/usr/bin/env",
					"-i",
					...Object.entries(env).flatMap(([key, value]) => (value === undefined ? [] : [`${key}=${value}`])),
					"/usr/bin/setsid",
					"--fork",
					process.execPath,
					"src/daemon.ts",
				],
				{ stdout: "pipe", stderr: "pipe", env: { ...process.env, XDG_RUNTIME_DIR: env.XDG_RUNTIME_DIR } },
			);
			owned = true;
			const output = await new Response(launch.stderr).text();
			expect(await launch.exited, output).toBe(0);
			let firstPid = 0;
			await until(
				async () => {
					try {
						const health = record((await request(daemon.origin, "/health")).body);
						expect(health.agentsDir).toBe(daemon.workspace);
						const capability = success(
							await request(daemon.origin, "/api/org/operator/capabilities", admin.credential),
							"capabilities",
						);
						firstPid = Number(health.pid);
						return record(capability.supervisor).kind === "systemd";
					} catch {
						return false;
					}
				},
				"supervised isolated daemon readiness",
				30_000,
			);
			const started = success(
				await request(daemon.origin, "/api/org/operator/restart", admin.credential, "POST", {}),
				"restart accepted",
			);
			expect(started.status).toBe("pending");
			let nextPid = firstPid;
			await until(
				async () => {
					try {
						const health = record((await request(daemon.origin, "/health")).body);
						expect(health.agentsDir).toBe(daemon.workspace);
						nextPid = Number(health.pid);
						if (nextPid === firstPid) return false;
						const job = success(
							await request(daemon.origin, `/api/org/jobs/${text(started.jobId)}`, admin.credential),
							"restart job",
						);
						return job.status === "complete";
					} catch {
						return false;
					}
				},
				"new supervised daemon and durable job completion",
				45_000,
			);
			expect(nextPid).not.toBe(firstPid);
			const cliEnv: NodeJS.ProcessEnv = { ...daemon.env, SIGNET_API_KEY: text(admin.credential.bearer) };
			delete cliEnv.SIGNET_DAEMON_ENTRYPOINT;
			const cli = Bun.spawn([process.execPath, join(repo, "surfaces/cli/src/cli.ts"), "restart", "--wait", "--json"], {
				env: cliEnv,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(cli.stdout).text(),
				new Response(cli.stderr).text(),
				cli.exited,
			]);
			expect(code, stderr).toBe(0);
			expect(record(JSON.parse(stdout)).status).toBe("complete");
			const finalHealth = record((await request(daemon.origin, "/health")).body);
			expect(finalHealth.agentsDir).toBe(daemon.workspace);
			expect(finalHealth.pid).not.toBe(nextPid);
			nextPid = Number(finalHealth.pid);
			expect((await systemctl(["show", unit, "--property=MainPID", "--value"])).stdout.trim()).toBe(String(nextPid));
		} finally {
			if (owned) {
				const stop = await systemctl(["stop", unit]);
				expect(stop.code, stop.stderr).toBe(0);
				expect((await systemctl(["show", unit, "--property=MainPID", "--value"])).stdout.trim()).toBe("0");
			}
			await daemon.dispose();
		}
	},
	120_000,
);
