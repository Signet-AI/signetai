import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { Hono } from "hono";
import { registerMemoryRoutes, writeCodexNativeNote } from "./memory-routes";

let dir: string | undefined;
const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
	if (dir) {
		rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	}
	if (originalCodexHome === undefined) {
		Reflect.deleteProperty(process.env, "CODEX_HOME");
	} else {
		process.env.CODEX_HOME = originalCodexHome;
	}
});

describe("writeCodexNativeNote", () => {
	it("uses exclusive create and retries same timestamp/title collisions", () => {
		dir = mkdtempSync(join(tmpdir(), "signet-codex-note-route-"));
		process.env.CODEX_HOME = dir;
		const now = new Date("2026-05-24T20:01:02.345Z");
		let suffix = 0;

		const first = writeCodexNativeNote(
			{ content: "first durable note", title: "Collision", tags: "codex" },
			{ now, uniqueSuffix: () => `retry-${((suffix += 1)).toString()}` },
		);
		const second = writeCodexNativeNote(
			{ content: "second durable note", title: "Collision", tags: "codex" },
			{ now, uniqueSuffix: () => `retry-${((suffix += 1)).toString()}` },
		);

		expect(first).not.toBe(second);
		expect(basename(first)).toBe("2026-05-24T20-01-02-345Z-collision.md");
		expect(basename(second)).toBe("2026-05-24T20-01-02-345Z-collision-retry-1.md");
		expect(readFileSync(first, "utf-8")).toContain("first durable note");
		expect(readFileSync(second, "utf-8")).toContain("second durable note");
	});
});

describe("remember route aliases", () => {
	it("forwards both aliases to the remember handler with the request context", async () => {
		const originalFetch = globalThis.fetch;
		const requests: Array<{ readonly url: string; readonly init: RequestInit | undefined }> = [];
		globalThis.fetch = async (input, init) => {
			requests.push({ url: input instanceof Request ? input.url : String(input), init });
			return new Response(JSON.stringify({ accepted: true }), {
				status: 202,
				headers: { "Content-Type": "application/json" },
			});
		};

		try {
			const app = new Hono();
			registerMemoryRoutes(app);
			const body = { content: "remember this" };
			for (const path of ["/api/memory/save", "/api/hook/remember"]) {
				const response = await app.request(path, {
					method: "POST",
					headers: {
						"Content-Type": "application/json",
						authorization: "Bearer test-token",
						"x-signet-session-key": "session-test",
					},
					body: JSON.stringify(body),
				});
				expect(response.status).toBe(202);
				expect(await response.json()).toEqual({ accepted: true });
			}

			expect(requests).toHaveLength(2);
			for (const request of requests) {
				expect(new URL(request.url).pathname).toBe("/api/memory/remember");
				const headers = new Headers(request.init?.headers);
				expect(headers.get("x-signet-operation-forwarded")).toBe("1");
				expect(headers.get("authorization")).toBe("Bearer test-token");
				expect(headers.get("x-signet-session-key")).toBe("session-test");
				expect(JSON.parse(String(request.init?.body))).toEqual(body);
			}
		} finally {
			globalThis.fetch = originalFetch;
		}
	});
});
