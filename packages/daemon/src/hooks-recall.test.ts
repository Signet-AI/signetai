import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app: {
	request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};
let dir = "";
let prev: string | undefined;

describe("/api/hooks/recall", () => {
	beforeAll(async () => {
		prev = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-hooks-recall-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(
			join(dir, "agent.yaml"),
			`memory:
  pipelineV2:
    enabled: false
`,
		);
		process.env.SIGNET_PATH = dir;

		const daemon = await import("./daemon");
		app = daemon.app;
	});

	afterAll(() => {
		if (prev === undefined) {
			delete process.env.SIGNET_PATH;
		} else {
			process.env.SIGNET_PATH = prev;
		}
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// cleanup best-effort
		}
	});

	it("returns 200 on valid recall request", async () => {
		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({
				harness: "openclaw",
				query: "test query",
				limit: 5,
			}),
		});

		// The route should resolve without crashing (no cfg ReferenceError),
		// even if the DB isn't fully initialized — the key contract is no 500.
		expect(resp.status).toBe(200);
		const body = await resp.json();
		expect(body.error).not.toBe("Hook execution failed");
	});

	it("rejects requests missing harness", async () => {
		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ query: "test" }),
		});

		expect(resp.status).toBe(400);
	});

	it("rejects requests missing query", async () => {
		const resp = await app.request("/api/hooks/recall", {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify({ harness: "openclaw" }),
		});

		expect(resp.status).toBe(400);
	});
});
