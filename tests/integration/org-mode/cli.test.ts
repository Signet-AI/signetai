import { expect, test } from "bun:test";
import { join } from "node:path";
import { OrgDaemon, repo } from "./daemon";
import { Fixture, device } from "./fixture";
import { browser, record, request, success, text } from "./http";

test("CLI organization admin flow uses the real isolated daemon", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.create(daemon, "personal", false);
		const admin = await device(daemon, fixture.admin, "cli-admin");
		const cli = async (args: readonly string[], bearer = admin.credential.bearer ?? "", expectedCode = 0) => {
			const env: NodeJS.ProcessEnv = { ...daemon.env, SIGNET_API_KEY: bearer };
			delete env.SIGNET_DAEMON_ENTRYPOINT;
			const child = Bun.spawn([process.execPath, join(repo, "surfaces/cli/src/cli.ts"), ...args], {
				env,
				cwd: repo,
				stdout: "pipe",
				stderr: "pipe",
			});
			const [stdout, stderr, code] = await Promise.all([
				new Response(child.stdout).text(),
				new Response(child.stderr).text(),
				child.exited,
			]);
			expect(code, stderr).toBe(expectedCode);
			if (expectedCode !== 0) expect(stdout).toBe("");
			return JSON.parse(expectedCode === 0 ? stdout : stderr);
		};
		const status = await cli(["status", "--json"]);
		expect(status.identity.organization.name).toBe("Org acceptance");
		expect((await cli(["logs", "--json", "--lines", "5"])).redacted).toBe(true);
		expect((await cli(["logs", "--follow", "--json"], text(fixture.user("alice").session.bearer), 4)).reason).toBe(
			"permission",
		);
		for (let iteration = 0; iteration < 3; iteration++) {
			const env: NodeJS.ProcessEnv = { ...daemon.env, SIGNET_API_KEY: admin.credential.bearer };
			delete env.SIGNET_DAEMON_ENTRYPOINT;
			const child = Bun.spawn([process.execPath, join(repo, "surfaces/cli/src/cli.ts"), "logs", "--follow", "--json"], {
				env,
				cwd: repo,
				stdout: "pipe",
				stderr: "pipe",
			});
			const errors = new Response(child.stderr).text();
			const reader = child.stdout.getReader();
			const deadline = setTimeout(() => child.kill("SIGKILL"), 10_000);
			let output = "";
			try {
				while (!output.includes("\n")) {
					const chunk = await reader.read();
					if (chunk.done) throw new Error(`Log stream closed before connection: ${await errors}`);
					output += new TextDecoder().decode(chunk.value);
				}
				expect(JSON.parse(output.split("\n")[0] ?? "").type).toBe("connected");
				child.kill("SIGINT");
				expect(await child.exited, await errors).toBe(0);
				expect(output).not.toContain(text(admin.credential.bearer));
			} finally {
				clearTimeout(deadline);
				if (child.exitCode === null) child.kill("SIGKILL");
				await child.exited;
				await reader.cancel();
				reader.releaseLock();
			}
		}
		expect(
			(await request(daemon.origin, "/api/pipeline/pause", fixture.user("alice").session, "POST", {})).status,
		).toBe(403);
		const scopedOperator = success(
			await request(daemon.origin, "/api/auth/api-keys", admin.credential, "POST", {
				name: "scoped-operator",
				agentId: record(status.identity.agents).defaultWrite,
				permissions: ["admin", "diagnostics"],
				expiresAt: new Date(Date.now() + 60_000).toISOString(),
			}),
			"create scoped operator key",
		);
		expect(
			(await request(daemon.origin, "/api/pipeline/pause", { bearer: text(scopedOperator.secret) }, "POST", {})).status,
		).toBe(403);
		const paused = success(
			await request(daemon.origin, "/api/pipeline/pause", admin.credential, "POST", {}),
			"pause organization workers",
		);
		expect(paused.paused).toBe(true);
		const pauseAudit = success(
			await request(daemon.origin, "/api/org/audit?action=operator.pipeline_paused", admin.credential),
			"read pause audit",
		);
		expect(Array.isArray(pauseAudit.events) && pauseAudit.events.length > 0).toBe(true);
		await daemon.restart();
		expect(
			success(await request(daemon.origin, "/api/pipeline/pause", admin.credential, "POST", {}), "verify durable pause")
				.changed,
		).toBe(false);
		expect((await cli(["resume", "--json"])).paused).toBe(false);
		expect((await cli(["daemon", "pause", "--json"])).paused).toBe(true);
		expect((await cli(["daemon", "resume", "--json"])).paused).toBe(false);
		const browserKey = success(
			await request(daemon.origin, "/api/auth/api-keys", admin.credential, "POST", {
				name: "browser-ceiling-proof",
				permissions: ["recall"],
				expiresAt: new Date(Date.now() + 300_000).toISOString(),
			}),
			"create browser key",
		);
		const exchanged = await request(
			daemon.origin,
			"/api/auth/session",
			{ bearer: text(browserKey.secret) },
			"POST",
			{},
		);
		const exchangedBody = success(exchanged, "exchange browser key");
		expect(exchangedBody).not.toHaveProperty("accessToken");
		const keyBrowser = browser(exchanged);
		const keyIdentity = success(await request(daemon.origin, "/api/auth/whoami", keyBrowser), "key browser identity");
		expect(keyIdentity.permissions).toEqual(["recall"]);
		success(
			await request(daemon.origin, `/api/auth/api-keys/${text(record(browserKey.key).id)}`, admin.credential, "DELETE"),
			"revoke browser parent",
		);
		expect((await request(daemon.origin, "/api/agents", keyBrowser)).status).toBe(401);
		const definition = await cli(
			["classification", "create", "CLI-private", "--audience", `group:${fixture.hrGroupId}`, "--json"],
			fixture.user("cora").session.bearer,
		);
		expect(definition.id).toStartWith("cls_");
		const invite = await cli(["org", "users", "invite", "--email", "cli-member@example.com", "--json"]);
		const accepted = await request(daemon.origin, "/api/auth/invites/accept", {}, "POST", {
			token: new URL(invite.inviteUrl).pathname.split("/").pop(),
			username: "cli-member",
			displayName: "CLI member",
			password: "isolated test password",
		});
		const member = success(accepted, "accept CLI invitation");
		const memberId = text(record(member.user).id);
		const memberDevice = await device(daemon, browser(accepted), "cli-member");
		const connected = await cli(["connect", "codex", "--url", daemon.origin, "--json"], memberDevice.credential.bearer);
		expect(JSON.stringify(connected)).not.toContain("sig_sk_");
		const identity = success(
			await request(daemon.origin, "/api/auth/whoami", memberDevice.credential),
			"member identity",
		);
		const agentId = text(record(identity.agents).defaultWrite);
		const memory = success(
			await request(daemon.origin, "/api/memory/remember", memberDevice.credential, "POST", {
				content: "CLI org admin fixture evidence",
				agentId,
			}),
			"remember member evidence",
		);
		expect(memory).toBeTruthy();
		const classified = await cli(
			["classify", `agent:${agentId}`, "--agent", agentId, "--as", fixture.hrId, "--wait", "--json"],
			fixture.user("cora").session.bearer,
		);
		expect(classified.job.status).toBe("complete");
		const access = await cli(["org", "access", memberId, "--json"]);
		expect(access.actAs.some((entry: { agentId: string }) => entry.agentId === agentId)).toBe(true);
		const plan = await cli(["org", "users", "deactivate", memberId, "--json"]);
		expect(plan.plan.counts.keys).toBe(0);
		expect(plan.plan.counts.memories).toBe(0);
		expect(plan.plan.counts.sessions).toBeGreaterThan(0);
		const offboard = await cli(["org", "users", "deactivate", memberId, "--confirm", "--wait", "--json"]);
		expect(offboard.status).toBe("complete");
		const denied = await request(daemon.origin, "/api/agents", memberDevice.credential);
		expect(denied.status).toBe(401);
		const audit = await cli(["audit", "--action", "user.deactivated", "--json"]);
		expect(audit.events.some((event: { target_id: string }) => event.target_id === memberId)).toBe(true);
	} finally {
		await daemon.dispose();
	}
}, 120_000);
