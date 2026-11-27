import { expect, test } from "bun:test";
import { NodeTransport, resolveTarget } from "../../../../libs/sdk/src/node.js";
import { organizationStatus, organizationDashboard } from "./organization-client.js";

test("remote status opens with organization identity and agent", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			return Response.json(
				new URL(request.url).pathname.endsWith("whoami")
					? {
							authenticated: true,
							mode: "team",
							organization: { name: "acme" },
							user: { email: "alice@acme.dev", username: "alice" },
							agents: { defaultRead: "org" },
							credential: { expiresAt: new Date(Date.now() + 6 * 86400_000).toISOString() },
						}
					: { running: true },
			);
		},
	});
	try {
		const output: string[] = [];
		const transport = new NodeTransport(
			await resolveTarget({ env: { SIGNET_DAEMON_URL: server.url.origin, SIGNET_API_KEY: "fixture" } }),
		);
		await organizationStatus(transport, false, (value) => output.push(value));
		expect(output[0]).toMatch(/^acme \(team\) · alice@acme.dev · agent: org · session expires in [56]d$/);
	} finally {
		server.stop(true);
	}
});
test("dashboard opens a one-time fragment code, never a bearer", async () => {
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch: () => Response.json({ code: "one-time-handoff", expiresAt: new Date(Date.now() + 60000).toISOString() }),
	});
	try {
		const target = await resolveTarget({
			env: { SIGNET_DAEMON_URL: server.url.origin, SIGNET_API_KEY: "fixture-bearer" },
		});
		const opened: string[] = [];
		await organizationDashboard(new NodeTransport(target), target.url, false, async (value) => {
			opened.push(value);
		});
		expect(opened).toEqual([`${server.url.origin}/#signet-handoff=one-time-handoff`]);
		expect(opened.join()).not.toContain("fixture-bearer");
		await expect(organizationDashboard(new NodeTransport(target), target.url, true, async () => {})).rejects.toThrow(
			"--non-interactive",
		);
	} finally {
		server.stop(true);
	}
});
