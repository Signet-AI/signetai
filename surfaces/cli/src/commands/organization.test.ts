import "../../../../tests/support/connector-safety.js";
import { expect, test } from "bun:test";
import { Command } from "commander";
import { registerOrganizationCommands } from "./organization.js";

test("admin commands preserve typed payloads and audit filters", async () => {
	const calls: { path: string; method: string; body: unknown }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			calls.push({
				path: new URL(request.url).pathname + new URL(request.url).search,
				method: request.method,
				body: request.method === "GET" ? null : await request.json(),
			});
			return Response.json({ ok: true });
		},
	});
	try {
		for (const args of [
			["org", "users", "list"],
			["org", "users", "invite", "--email", "bob@example.com", "--role", "member", "--team", "grp_eng"],
			["org", "users", "role", "usr_bob", "readonly"],
			["org", "users", "reactivate", "usr_bob"],
			["org", "teams", "create", "payments"],
			["org", "teams", "add", "grp_eng", "usr_bob", "--role", "owner"],
			["org", "access", "usr_bob"],
			["audit", "--actor", "usr_bob", "--action", "user.deactivated", "--since", "2026-11-01T00:00:00Z"],
		]) {
			const program = new Command();
			registerOrganizationCommands(program, {
				env: { SIGNET_DAEMON_URL: server.url.origin, SIGNET_API_KEY: "fixture" },
				print: () => {},
			});
			await program.parseAsync([...args, "--json"], { from: "user" });
		}
		expect(calls).toEqual([
			{ path: "/api/org/users", method: "GET", body: null },
			{
				path: "/api/org/invites",
				method: "POST",
				body: { email: "bob@example.com", role: "member", groupIds: ["grp_eng"] },
			},
			{ path: "/api/org/users/usr_bob", method: "PATCH", body: { role: "readonly" } },
			{ path: "/api/org/users/usr_bob/reactivate", method: "POST", body: {} },
			{ path: "/api/org/groups", method: "POST", body: { name: "payments" } },
			{ path: "/api/org/groups/grp_eng/members/usr_bob", method: "PUT", body: { role: "owner" } },
			{ path: "/api/org/access/usr_bob", method: "GET", body: null },
			{
				path: "/api/org/audit?actor=usr_bob&action=user.deactivated&since=2026-11-01T00%3A00%3A00Z",
				method: "GET",
				body: null,
			},
		]);
	} finally {
		server.stop(true);
	}
});

test("classify previews impact before dispatch and waits for terminal status", async () => {
	const calls: string[] = [];
	const output: string[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		fetch(request) {
			const path = new URL(request.url).pathname;
			calls.push(path);
			if (path === "/api/classifications") return Response.json([{ id: "cls_hr", name: "HR" }]);
			if (path.endsWith("/preview")) return Response.json({ evidence: 1, derived: 14 });
			if (path.endsWith("/apply")) return Response.json({ jobId: "job_classify" }, { status: 202 });
			return Response.json({ id: "job_classify", status: "complete" });
		},
	});
	try {
		const program = new Command();
		registerOrganizationCommands(program, {
			env: { SIGNET_DAEMON_URL: server.url.origin, SIGNET_API_KEY: "fixture" },
			print: (value) => output.push(value),
		});
		await program.parseAsync(["classify", "memory:mem_1", "--agent", "agent_a", "--as", "HR", "--wait", "--json"], {
			from: "user",
		});
		expect(calls).toEqual([
			"/api/classifications",
			"/api/classifications/cls_hr/preview",
			"/api/classifications/cls_hr/apply",
			"/api/org/jobs/job_classify",
		]);
		expect(JSON.parse(output.at(-1) ?? "null")).toMatchObject({
			preview: { derived: 14 },
			jobId: "job_classify",
			job: { status: "complete" },
		});
	} finally {
		server.stop(true);
	}
});

test("classification definition commands keep audience principals explicit", async () => {
	const calls: { path: string; method: string; body: unknown }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			calls.push({
				path: new URL(request.url).pathname,
				method: request.method,
				body: request.method === "GET" ? null : await request.json(),
			});
			return Response.json([]);
		},
	});
	try {
		for (const args of [
			["classification", "create", "HR", "--audience", "group:grp_hr", "user:usr_carol"],
			["classification", "audience", "cls_hr", "--audience", "group:grp_hr"],
			["classification", "list"],
			["org", "agents", "list"],
		]) {
			const program = new Command();
			registerOrganizationCommands(program, {
				env: { SIGNET_DAEMON_URL: server.url.origin, SIGNET_API_KEY: "fixture" },
				print: () => {},
			});
			await program.parseAsync([...args, "--json"], { from: "user" });
		}
		expect(calls).toEqual([
			{
				path: "/api/classifications",
				method: "POST",
				body: {
					name: "HR",
					audience: [
						{ kind: "group", id: "grp_hr" },
						{ kind: "user", id: "usr_carol" },
					],
				},
			},
			{ path: "/api/classifications/cls_hr/audience", method: "PUT", body: [{ kind: "group", id: "grp_hr" }] },
			{ path: "/api/classifications", method: "GET", body: null },
			{ path: "/api/agents", method: "GET", body: null },
		]);
	} finally {
		server.stop(true);
	}
});

test("offboarding defaults to preview and --confirm --wait follows the job", async () => {
	const calls: { path: string; body: unknown }[] = [];
	const server = Bun.serve({
		hostname: "127.0.0.1",
		port: 0,
		async fetch(request) {
			const path = new URL(request.url).pathname;
			const body = request.method === "GET" ? null : await request.json();
			calls.push({ path, body });
			if (path.endsWith("/deactivate"))
				return Response.json(body.dryRun ? { plan: { counts: { keys: 2 } } } : { jobId: "job_offboard" });
			return Response.json({ id: "job_offboard", status: "complete" });
		},
	});
	try {
		const output: string[] = [];
		for (const flags of [[], ["--confirm", "--wait"]]) {
			const program = new Command();
			registerOrganizationCommands(program, {
				env: { SIGNET_DAEMON_URL: server.url.origin, SIGNET_API_KEY: "fixture" },
				print: (value) => output.push(value),
			});
			await program.parseAsync(["org", "users", "deactivate", "usr_member", ...flags, "--json"], { from: "user" });
		}
		expect(calls).toEqual([
			{ path: "/api/org/users/usr_member/deactivate", body: { mode: "keep", dryRun: true } },
			{ path: "/api/org/users/usr_member/deactivate", body: { mode: "keep", dryRun: false } },
			{ path: "/api/org/jobs/job_offboard", body: null },
		]);
		expect(JSON.parse(output.at(-1) ?? "null").status).toBe("complete");
	} finally {
		server.stop(true);
	}
});
