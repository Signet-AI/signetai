import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let app: {
	request: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
};
let dir = "";
let prev: string | undefined;

describe("daemon CORS", () => {
	beforeAll(async () => {
		prev = process.env.SIGNET_PATH;
		dir = mkdtempSync(join(tmpdir(), "signet-daemon-cors-"));
		mkdirSync(join(dir, "memory"), { recursive: true });
		writeFileSync(
			join(dir, "agent.yaml"),
			`network:
  mode: tailscale
memory:
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
			// biome-ignore lint/performance/noDelete: deleting env keys avoids stringifying undefined in process.env.
			delete process.env.SIGNET_PATH;
		}
		if (prev !== undefined) process.env.SIGNET_PATH = prev;
		rmSync(dir, { recursive: true, force: true });
	});

	it("allows tailscale ip origins on the daemon port", async () => {
		const origin = "http://100.100.100.100:3850";
		const res = await app.request("http://localhost/health", {
			headers: { Origin: origin },
		});

		expect(res.headers.get("access-control-allow-origin")).toBe(origin);
	});

	it("rejects non-tailscale origins on the daemon port", async () => {
		const res = await app.request("http://localhost/health", {
			headers: { Origin: "http://example.com:3850" },
		});

		expect(res.headers.get("access-control-allow-origin")).toBeNull();
	});

	it("keeps Electron desktop app origin allowlisted", async () => {
		const origin = "app://signet";
		const res = await app.request("http://localhost/health", {
			headers: { Origin: origin },
		});

		expect(res.headers.get("access-control-allow-origin")).toBe(origin);
	});

	it("keeps localhost dev origins allowlisted", async () => {
		const origin = "http://localhost:5173";
		const res = await app.request("http://localhost/health", {
			headers: { Origin: origin },
		});

		expect(res.headers.get("access-control-allow-origin")).toBe(origin);
	});
});
