import "../../../../tests/support/connector-safety.js";
import { test, expect } from "bun:test";
import { join } from "node:path";
const repo = join(import.meta.dir, "../../../..");
test("registered text surfaces share canonical names and hidden-author redaction while JSON preserves ids", async () => {
	let hidden = false;
	const row = {
		id: "memory-id",
		content: "marker",
		agent_id: "agent-id",
		authorUserId: "person-id",
		who: "spoofed harness",
		created_at: "2026-01-01T00:00:00Z",
	};
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			if (path === "/health/live" || path === "/health" || path === "/api/status")
				return Response.json({ status: "ok", running: true });
			if (path === "/api/result-attribution")
				return Response.json({
					authors: hidden ? [] : [{ id: "person-id", name: "Alice Smith", handle: "alice" }],
					agents: [{ id: "agent-id", name: "Engineering" }],
					memories: [{ id: "memory-id", authorUserId: "person-id", agentId: "agent-id" }],
				});
			if (path === "/api/memory/recall") return Response.json({ results: [row] });
			if (path === "/api/memories") return Response.json({ memories: [row] });
			if (path === "/api/memory/memory-id") return Response.json(row);
			if (path === "/api/sessions/search")
				return Response.json({
					query: "marker",
					hits: [{ ...row, sessionKey: "session-key", updatedAt: row.created_at, excerpt: "marker" }],
				});
			if (path === "/api/sessions") return Response.json({ sessions: [{ ...row, sessionKey: "session-key" }] });
			if (path === "/api/sources") return Response.json({ sources: [{ ...row, name: "Vault", kind: "obsidian" }] });
			if (path === "/api/dream/status")
				return Response.json({
					worker: { running: false },
					state: { lastPassAt: null },
					episodicTokensPending: null,
					config: { tokenThreshold: 100 },
					passes: [
						{ ...row, mode: "incremental", status: "completed", startedAt: row.created_at, mutationsApplied: null },
					],
				});
			if (path === "/api/org/audit")
				return Response.json({
					events: [
						{ ...row, actor_user_id: "person-id", action: "memory.remember", at: row.created_at },
						{
							id: "system-event",
							actor_credential: "system",
							action: "operator.restart_completed",
							at: row.created_at,
						},
					],
				});
			return Response.json({ error: "unexpected fixture endpoint" }, { status: 404 });
		},
	});
	try {
		for (const args of [
			["recall", "marker"],
			["memory", "list"],
			["memory", "show", "memory-id"],
			["search", "marker"],
			["session", "search", "marker"],
			["session", "list"],
			["sources", "list"],
			["dream", "status"],
			["audit"],
		]) {
			for (const hide of [false, true]) {
				hidden = hide;
				const child = Bun.spawn([process.execPath, join(repo, "surfaces/cli/src/cli.ts"), ...args], {
					cwd: repo,
					env: {
						...process.env,
						SIGNET_DAEMON_URL: server.url.origin,
						SIGNET_API_KEY: "fixture-attribution",
						NO_COLOR: "1",
					},
					stdout: "pipe",
					stderr: "pipe",
				});
				const [out, err, code] = await Promise.all([
					new Response(child.stdout).text(),
					new Response(child.stderr).text(),
					child.exited,
				]);
				expect(code, `${args.join(" ")}: ${err}`).toBe(0);
				expect(out, `${args.join(" ")}: ${err}`).toContain(
					hide ? "author: Another person" : "author: Alice Smith (@alice)",
				);
				expect(out).toContain("agent: Engineering");
				if (args[0] === "audit") expect(out).toContain("author: Signet");
				expect(out).not.toContain("person-id");
				expect(out).not.toContain("agent-id");
				expect(out).not.toContain("spoofed harness");
				if (hide) expect(out).not.toContain("Alice Smith");
			}
			const json = Bun.spawn([process.execPath, join(repo, "surfaces/cli/src/cli.ts"), ...args, "--json"], {
				cwd: repo,
				env: {
					...process.env,
					SIGNET_DAEMON_URL: server.url.origin,
					SIGNET_API_KEY: "fixture-attribution",
					NO_COLOR: "1",
				},
				stdout: "pipe",
				stderr: "pipe",
			});
			const [out, err, code] = await Promise.all([
				new Response(json.stdout).text(),
				new Response(json.stderr).text(),
				json.exited,
			]);
			expect(code, err).toBe(0);
			expect(JSON.parse(out)).toBeTruthy();
			expect(out).toContain("person-id");
			expect(out).toContain("agent-id");
		}
	} finally {
		server.stop(true);
	}
}, 60000);
