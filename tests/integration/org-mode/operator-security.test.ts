import { expect, test } from "bun:test";
import { OrgDaemon } from "./daemon";
import { Fixture, device } from "./fixture";
import { record, request, success, text } from "./http";
import effects from "../../../platform/daemon/src/route-effects.json";

test("real HTTP and MCP hide another admin's job and HR write log metadata", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.create(daemon, "personal", false);
		const admin = await device(daemon, fixture.admin, "operator-proof");
		const other = fixture.user("audra");
		const job = success(
			await request(daemon.origin, "/api/org/operator/jobs", other.session, "POST", {
				action: "queue.requeue",
				agentId: other.agentId,
			}),
			"other admin job",
		);
		const id = text(job.jobId);
		const hidden = await request(daemon.origin, `/api/org/jobs/${id}`, admin.credential);
		const absent = await request(daemon.origin, "/api/org/jobs/job_missing", admin.credential);
		expect(hidden.status).toBe(404);
		expect(hidden.body).toEqual(absent.body);
		for (const path of ["/api/org/jobs", "/api/org/jobs?kind=operator"]) {
			const list = await request(daemon.origin, path, admin.credential);
			expect(list.status).toBe(200);
			expect(JSON.stringify(list.body)).not.toContain(id);
		}
		const mcp = async (jobId: string) => {
			const response = await fetch(`${daemon.origin}/mcp`, {
				method: "POST",
				headers: {
					authorization: `Bearer ${text(admin.credential.bearer)}`,
					"content-type": "application/json",
					accept: "application/json, text/event-stream",
				},
				body: JSON.stringify({
					jsonrpc: "2.0",
					id: 1,
					method: "tools/call",
					params: { name: "signet_org_job", arguments: { jobId } },
				}),
			});
			const raw = await response.text();
			const data =
				raw
					.split("\n")
					.find((line) => line.startsWith("data:"))
					?.slice(5) ?? raw;
			return record(record(JSON.parse(data)).result);
		};
		expect(await mcp(id)).toEqual(await mcp("job_missing"));
		const carol = fixture.user("carol");
		await fixture.classify("agent", carol.agentId, carol.agentId);
		const before = await request(daemon.origin, "/api/logs?limit=500", admin.credential);
		const abort = new AbortController();
		const stream = await fetch(`${daemon.origin}/api/logs/stream?limit=500`, {
			signal: abort.signal,
			headers: { authorization: `Bearer ${text(admin.credential.bearer)}` },
		});
		const reader = stream.body?.getReader();
		if (!reader) throw new Error("missing stream");
		expect(new TextDecoder().decode((await reader.read()).value)).toContain("connected");
		try {
			success(
				await request(daemon.origin, "/api/hooks/session-start", carol.session, "POST", {
					harness: "codex",
					sessionKey: "classified-log-proof",
					agentId: carol.agentId,
					project: "hidden-project",
				}),
				"classified session start",
			);
			const memory = success(
				await request(daemon.origin, "/api/memory/remember", carol.session, "POST", {
					content: "HR hidden write timing proof",
					agentId: carol.agentId,
				}),
				"HR write",
			);
			const memoryId = typeof memory.id === "string" ? memory.id : text(record(memory.memory).id);
			expect((await request(daemon.origin, `/api/memory/${memoryId}`, admin.credential)).status).toBe(404);
			const after = await request(daemon.origin, "/api/logs?limit=500", admin.credential);
			expect(after.body).toEqual(before.body);
			for (const routes of Object.values(effects)) {
				for (const [route, effect] of Object.entries(routes)) {
					const [method, pattern] = route.split(" ");
					if (!method || !pattern) throw new Error("Invalid route inventory");
					if (
						(!["POST", "PUT", "PATCH", "DELETE"].includes(method) && !pattern.startsWith("/api/hooks/")) ||
						effect === "host" ||
						effect === "supervised"
					)
						continue;
					const path = pattern
						.replace(/\$\{[^}]+\}/g, "probe")
						.replace(/:[^/{}]+\{[^}]+\}/g, "missing")
						.replace(/:[^/]+/g, "missing");
					const credential = /^\/api\/(auth|org)\//.test(pattern) ? carol.connector : carol.session;
					await request(
						daemon.origin,
						path,
						credential,
						method,
						method === "GET"
							? undefined
							: {
									agentId: carol.agentId,
									harness: "codex",
									sessionKey: "classified-log-proof",
									content: "classified write sweep",
									userMessage: "hidden prompt",
									summary: "hidden summary",
									reason: "session_shutdown",
									transcript: "User: hidden\nAssistant: recorded",
								},
					);
					const snapshot = await request(daemon.origin, "/api/logs?limit=500", admin.credential);
					expect({ route, body: snapshot.body }).toEqual({ route, body: before.body });
				}
			}
			const observed = (async () => {
				try {
					for (;;) {
						const frame = await reader.read();
						if (frame.done) return "closed";
						const text = new TextDecoder().decode(frame.value);
						if (text.split("\n").some((line) => line.startsWith("data:"))) return text;
					}
				} catch {
					return "aborted";
				}
			})();
			await new Promise((resolve) => setTimeout(resolve, 300));
			abort.abort();
			expect(["closed", "aborted"]).toContain(await observed);
		} finally {
			abort.abort();
			await reader.cancel().catch(() => undefined);
		}
		const identity = success(await request(daemon.origin, "/api/auth/whoami", fixture.admin), "admin identity");
		const adminAgent = text(record(identity.agents).defaultWrite);
		const controller = new AbortController();
		const authorized = await fetch(`${daemon.origin}/api/logs/stream`, {
			signal: controller.signal,
			headers: { authorization: `Bearer ${text(admin.credential.bearer)}` },
		});
		const authorizedReader = authorized.body?.getReader();
		if (!authorizedReader) throw new Error("missing revalidation stream");
		try {
			expect(new TextDecoder().decode((await authorizedReader.read()).value)).toContain("connected");
			success(
				await request(daemon.origin, `/api/auth/sessions/${admin.sessionId}`, fixture.admin, "DELETE"),
				"revoke log viewer session",
			);
			success(
				await request(daemon.origin, "/api/hooks/session-start", fixture.admin, "POST", {
					harness: "codex",
					agentId: adminAgent,
					sessionKey: "post-revocation-log",
				}),
				"eligible event after revocation",
			);
			const frame = new TextDecoder().decode((await authorizedReader.read()).value);
			expect(frame).toContain("scope_changed");
			expect(frame).not.toContain('"category"');
		} finally {
			controller.abort();
			await authorizedReader.cancel().catch(() => undefined);
		}
	} finally {
		await daemon.dispose();
	}
}, 60_000);

test("log stream rechecks transferred subject ownership before delivery", async () => {
	const daemon = await OrgDaemon.create();
	const abort = new AbortController();
	try {
		const fixture = await Fixture.create(daemon, "personal", false);
		const admin = await device(daemon, fixture.admin, "log-transfer");
		const identity = success(
			await request(daemon.origin, "/api/auth/whoami", admin.credential),
			"log transfer identity",
		);
		const agentId = text(record(identity.agents).defaultWrite);
		const response = await fetch(`${daemon.origin}/api/logs/stream`, {
			signal: abort.signal,
			headers: { authorization: `Bearer ${text(admin.credential.bearer)}` },
		});
		const reader = response.body?.getReader();
		if (!reader) throw new Error("missing transfer stream");
		try {
			expect(new TextDecoder().decode((await reader.read()).value)).toContain("connected");
			const carol = fixture.user("carol");
			success(
				await request(daemon.origin, `/api/agents/${agentId}`, fixture.admin, "PATCH", { ownerUserId: carol.id }),
				"transfer log subject",
			);
			success(
				await request(daemon.origin, "/api/hooks/session-start", carol.session, "POST", {
					agentId,
					harness: "codex",
					sessionKey: "transferred-log-subject",
				}),
				"new owner hook",
			);
			const frame = new TextDecoder().decode((await reader.read()).value);
			expect(frame).toContain("scope_changed");
			expect(frame).not.toContain('"category"');
		} finally {
			abort.abort();
			await reader.cancel().catch(() => undefined);
		}
	} finally {
		abort.abort();
		await daemon.dispose();
	}
}, 60_000);

test("classified memory mutation logs retain their subject compartment", async () => {
	const daemon = await OrgDaemon.create();
	try {
		const fixture = await Fixture.create(daemon, "single", false);
		const carol = fixture.user("carol");
		const memory = success(
			await request(daemon.origin, "/api/memory/remember", carol.session, "POST", {
				content: "private mutation log proof",
				agentId: carol.agentId,
			}),
			"create classified memory",
		);
		const id = text(memory.id);
		await fixture.classify("memory", id, carol.agentId);
		expect((await request(daemon.origin, `/api/memory/${id}`, fixture.admin)).status).toBe(404);
		const before = await request(daemon.origin, "/api/logs?limit=500", fixture.admin);
		success(
			await request(daemon.origin, `/api/memory/${id}`, carol.session, "PATCH", {
				importance: 0.9,
				agentId: carol.agentId,
				reason: "log proof correction",
			}),
			"update classified memory",
		);
		const after = await request(daemon.origin, "/api/logs?limit=500", fixture.admin);
		expect(after.body).toEqual(before.body);
	} finally {
		await daemon.dispose();
	}
}, 60_000);
