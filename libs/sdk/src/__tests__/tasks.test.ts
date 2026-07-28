import { afterEach, describe, expect, test } from "bun:test";
import type { Server } from "bun";
import { SignetClient } from "../index.js";

interface RecordedRequest {
	readonly method: string;
	readonly path: string;
	readonly query: Record<string, string>;
	readonly body: unknown;
}

let servers: Server[] = [];
let recorded: RecordedRequest[] = [];

function mockDaemon(responseOverride?: (req: RecordedRequest) => unknown): { server: Server; client: SignetClient } {
	const server = Bun.serve({
		port: 0,
		async fetch(req) {
			const url = new URL(req.url);
			const query: Record<string, string> = {};
			for (const [k, v] of url.searchParams) {
				query[k] = v;
			}

			let body: unknown = null;
			const ct = req.headers.get("content-type");
			if (ct?.includes("application/json")) {
				body = await req.json();
			}

			const entry: RecordedRequest = {
				method: req.method,
				path: url.pathname,
				query,
				body,
			};
			recorded.push(entry);

			const responseBody = responseOverride ? responseOverride(entry) : { ok: true };
			return Response.json(responseBody);
		},
	});

	servers.push(server);
	const client = new SignetClient({
		daemonUrl: `http://localhost:${server.port}`,
		retries: 0,
	});

	return { server, client };
}

function lastRequest(): RecordedRequest {
	const req = recorded[recorded.length - 1];
	if (!req) throw new Error("No requests recorded");
	return req;
}

afterEach(() => {
	for (const s of servers) {
		s.stop(true);
	}
	servers = [];
	recorded = [];
});

describe("Tasks/Scheduler API", () => {
	test("listTasks() sends GET /api/tasks", async () => {
		const { client } = mockDaemon();
		await client.listTasks();

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/tasks");
	});

	test("createTask() sends POST /api/tasks with payload", async () => {
		const { client } = mockDaemon();
		await client.createTask({
			name: "Daily Report",
			prompt: "Generate daily report",
			cronExpression: "0 9 * * *",
			harness: "claude-code",
			workingDirectory: "/home/user/project",
			skillName: "report-gen",
			skillMode: "inject",
		});

		const req = lastRequest();
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/api/tasks");
		expect(req.body).toEqual({
			name: "Daily Report",
			prompt: "Generate daily report",
			cronExpression: "0 9 * * *",
			harness: "claude-code",
			workingDirectory: "/home/user/project",
			skillName: "report-gen",
			skillMode: "inject",
		});
	});

	test("getTask() sends GET /api/tasks/:id", async () => {
		const { client } = mockDaemon();
		await client.getTask("task-abc-123");

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/tasks/task-abc-123");
	});

	test("updateTask() sends PATCH /api/tasks/:id with patch", async () => {
		const { client } = mockDaemon();
		await client.updateTask("task-xyz-789", {
			enabled: false,
			prompt: "Updated prompt",
		});

		const req = lastRequest();
		expect(req.method).toBe("PATCH");
		expect(req.path).toBe("/api/tasks/task-xyz-789");
		expect(req.body).toEqual({
			enabled: false,
			prompt: "Updated prompt",
		});
	});

	test("deleteTask() sends DELETE /api/tasks/:id", async () => {
		const { client } = mockDaemon();
		await client.deleteTask("task-del-456");

		const req = lastRequest();
		expect(req.method).toBe("DELETE");
		expect(req.path).toBe("/api/tasks/task-del-456");
	});

	test("runTask() sends POST /api/tasks/:id/run", async () => {
		const { client } = mockDaemon((req) => {
			if (req.path === "/api/tasks/task-run-123/run") {
				return { runId: "run-abc", status: "running" };
			}
			return { ok: true };
		});
		const result = await client.runTask("task-run-123");

		const req = lastRequest();
		expect(req.method).toBe("POST");
		expect(req.path).toBe("/api/tasks/task-run-123/run");
		expect(req.body).toEqual({});
		expect(result).toEqual({ runId: "run-abc", status: "running" });
	});

	test("listTaskRuns() sends GET /api/tasks/:id/runs with query params", async () => {
		const { client } = mockDaemon((req) => {
			if (req.path === "/api/tasks/task-runs-123/runs") {
				return {
					runs: [{ id: "run-1", task_id: "task-runs-123", status: "running" }],
					total: 1,
					hasMore: false,
				};
			}
			return { ok: true };
		});
		const response = await client.listTaskRuns("task-runs-123", { limit: 20, offset: 5 });

		const req = lastRequest();
		expect(req.method).toBe("GET");
		expect(req.path).toBe("/api/tasks/task-runs-123/runs");
		expect(req.query.limit).toBe("20");
		expect(req.query.offset).toBe("5");
		expect(response.total).toBe(1);
		expect(response.hasMore).toBe(false);
		expect(response.runs).toHaveLength(1);
	});
});
