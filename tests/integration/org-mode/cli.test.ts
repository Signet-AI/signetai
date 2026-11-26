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
		const cli = async (args: readonly string[], bearer = admin.credential.bearer ?? "") => {
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
			expect(code, stderr).toBe(0);
			return JSON.parse(stdout);
		};
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
		expect(plan.plan.counts.keys).toBeGreaterThan(0);
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
