import { expect, test } from "bun:test";
import { OrgDaemon } from "./daemon";
import { Fixture, device } from "./fixture";
import { record, request, success, text } from "./http";

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
		const before = await request(daemon.origin, "/api/logs?category=memory", admin.credential);
		const abort = new AbortController();
		const stream = await fetch(`${daemon.origin}/api/logs/stream?category=memory&limit=1`, {
			signal: abort.signal,
			headers: { authorization: `Bearer ${text(admin.credential.bearer)}` },
		});
		const reader = stream.body?.getReader();
		if (!reader) throw new Error("missing stream");
		expect(new TextDecoder().decode((await reader.read()).value)).toContain("connected");
		try {
			const memory = success(
				await request(daemon.origin, "/api/memory/remember", carol.session, "POST", {
					content: "HR hidden write timing proof",
					agentId: carol.agentId,
				}),
				"HR write",
			);
			const memoryId = typeof memory.id === "string" ? memory.id : text(record(memory.memory).id);
			expect((await request(daemon.origin, `/api/memory/${memoryId}`, admin.credential)).status).toBe(404);
			const after = await request(daemon.origin, "/api/logs?category=memory", admin.credential);
			expect(after.body).toEqual(before.body);
			const observed = reader.read().then(
				(frame) => (frame.done ? "closed" : new TextDecoder().decode(frame.value)),
				() => "aborted",
			);
			await new Promise((resolve) => setTimeout(resolve, 300));
			abort.abort();
			expect(["closed", "aborted"]).toContain(await observed);
		} finally {
			abort.abort();
			await reader.cancel().catch(() => undefined);
		}
	} finally {
		await daemon.dispose();
	}
}, 60_000);
