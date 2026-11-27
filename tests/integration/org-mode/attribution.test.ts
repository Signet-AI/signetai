import { test, expect } from "bun:test";
import { join } from "node:path";
import { OrgDaemon, repo } from "./daemon";
import { Fixture } from "./fixture";
import { request, success, text, record } from "./http";
test("real organization CLI attributes canonical memory evidence and redacts another person's name", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.create(daemon, "personal", false),
			alice = fixture.user("alice"),
			bob = fixture.user("bob");
		const identity = success(await request(daemon.origin, "/api/auth/whoami", alice.session), "identity"),
			name = text(record(identity.user).displayName);
		const memory = success(
			await request(daemon.origin, "/api/memory/remember", alice.session, "POST", {
				agentId: alice.agentId,
				content: "canonical attribution acceptance marker",
				who: "spoofed harness",
			}),
			"remember",
		);
		const id = text(memory.id);
		for (const args of [
			["recall", "canonical attribution acceptance marker"],
			["search", "canonical attribution acceptance marker"],
			["memory", "list"],
			["memory", "show", id],
		]) {
			for (const [user, hidden] of [
				[alice, false],
				[bob, true],
			] as const) {
				const env = { ...daemon.env, SIGNET_API_KEY: text(user.session.bearer), NO_COLOR: "1" };
				delete env.SIGNET_DAEMON_ENTRYPOINT;
				const child = Bun.spawn([process.execPath, join(repo, "surfaces/cli/src/cli.ts"), ...args], {
					cwd: repo,
					env,
					stdout: "pipe",
					stderr: "pipe",
				});
				const [out, err, code] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(code, `${args.join(" ")}: ${out}\n${err}`).toBe(0);
				expect(out).toContain(hidden ? "author: Another person" : `author: ${name}`);
				expect(out).toContain("agent:");
				expect(out).not.toContain(alice.id);
				expect(out).not.toContain(alice.agentId);
				expect(out).not.toContain("spoofed harness");
				if (hidden) expect(out).not.toContain(`author: ${name}`);
			}
		}
	} finally {
		await daemon.dispose();
	}
}, 60000);
