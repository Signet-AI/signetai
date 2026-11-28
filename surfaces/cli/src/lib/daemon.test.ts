import "../../../../tests/support/connector-safety.js";
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chmod, mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:http";
import { workspaceSocketPath } from "@signet/core/local-endpoint";
import { Command } from "commander";
import { createCliNodeTransport } from "./socket-transport.js";
import { registerOrganizationTarget } from "./organization-target.js";
import { createDaemonClient } from "./daemon.js";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
	registerOrganizationTarget(new Command());
});

describe("createDaemonClient", () => {
	test("all shared request forms automatically use the owned workspace socket", async () => {
		const root = await mkdtemp(join(tmpdir(), ""));
		const previousRuntime = process.env.XDG_RUNTIME_DIR;
		const previousPath = process.env.SIGNET_PATH;
		process.env.SIGNET_PATH = root;
		const previousUrl = process.env.SIGNET_DAEMON_URL;
		process.env.XDG_RUNTIME_DIR = root;
		Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
		const path = workspaceSocketPath(root);
		await mkdir(join(root, "signet"), { mode: 0o700 });
		const server = createServer((_req, res) => {
			res.setHeader("content-type", "application/json");
			res.end(JSON.stringify({ transport: "socket" }));
		});
		try {
			await new Promise<void>((resolve) => server.listen(path, resolve));
			await chmod(path, 0o600);
			const client = createDaemonClient(1, root);
			expect(await client.fetchDaemonResult("/api/git/status")).toEqual({ ok: true, data: { transport: "socket" } });
			expect(await client.secretApiCall("POST", "/api/secrets/exec", { command: "test" })).toEqual({
				ok: true,
				data: { transport: "socket" },
			});
			const stream = await client.fetchDaemonStream("/stream");
			expect(stream.ok).toBe(true);
			if (!stream.ok) throw new Error("Socket stream failed");
			expect(await stream.response.json()).toEqual({ transport: "socket" });
			const node = createCliNodeTransport({
				url: "http://127.0.0.1:1",
				origin: "http://127.0.0.1:1",
				remote: false,
				credential: { source: "none", get: async () => null },
			});
			expect(await node.get<{ transport: string }>("/api/org/remote-features")).toEqual({ transport: "socket" });
			const program = new Command();
			registerOrganizationTarget(program);
			program.command("probe").action(async () => {
				globalThis.fetch = async () => Response.json({ transport: "tcp" });
				expect(await client.fetchDaemonResult("/api/git/status")).toEqual({ ok: true, data: { transport: "tcp" } });
			});
			await program.parseAsync(["--local", "--no-socket", "probe"], { from: "user" });
			await chmod(path, 0o666);
			registerOrganizationTarget(new Command());
			await expect(client.fetchDaemonResult("/api/git/status")).rejects.toThrow("Unsafe local socket");
		} finally {
			await new Promise<void>((resolve) => server.close(() => resolve()));
			if (previousPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
			else process.env.SIGNET_PATH = previousPath;
			if (previousRuntime === undefined) Reflect.deleteProperty(process.env, "XDG_RUNTIME_DIR");
			else process.env.XDG_RUNTIME_DIR = previousRuntime;
			if (previousUrl === undefined) Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
			else process.env.SIGNET_DAEMON_URL = previousUrl;
			await rm(root, { recursive: true, force: true });
		}
	});
	test("fetchDaemonResult sends SIGNET_API_KEY as bearer auth", async () => {
		const previous = process.env.SIGNET_API_KEY;
		process.env.SIGNET_API_KEY = "sig_sk_test_secret";
		let authorization = "";
		globalThis.fetch = async (_input, init) => {
			authorization = new Headers(init?.headers).get("authorization") ?? "";
			return Response.json({ ok: true });
		};

		try {
			const client = createDaemonClient(3850);
			await client.fetchDaemonResult("/api/auth/whoami");
			expect(authorization).toBe("Bearer sig_sk_test_secret");
		} finally {
			if (previous === undefined) Reflect.deleteProperty(process.env, "SIGNET_API_KEY");
			else process.env.SIGNET_API_KEY = previous;
		}
	});

	test("fetchDaemonResult uses SIGNET_DAEMON_URL when configured", async () => {
		const previous = process.env.SIGNET_DAEMON_URL;
		process.env.SIGNET_DAEMON_URL = "http://192.168.0.60:3850/";
		let seenUrl = "";
		globalThis.fetch = async (input) => {
			seenUrl = String(input);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		try {
			const client = createDaemonClient(3850);
			await client.fetchDaemonResult("/api/hooks/session-start");

			expect(client.url).toBe("http://192.168.0.60:3850");
			expect(seenUrl).toBe("http://192.168.0.60:3850/api/hooks/session-start");
		} finally {
			if (previous === undefined) Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
			else process.env.SIGNET_DAEMON_URL = previous;
		}
	});

	test("rejects invalid SIGNET_DAEMON_URL instead of falling back to localhost", () => {
		const previous = process.env.SIGNET_DAEMON_URL;
		process.env.SIGNET_DAEMON_URL = "ssh://192.168.0.60:3850";

		try {
			expect(() => createDaemonClient(3850)).toThrow("SIGNET_DAEMON_URL must use http or https");
		} finally {
			if (previous === undefined) Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
			else process.env.SIGNET_DAEMON_URL = previous;
		}
	});

	test("rejects a malformed persisted URL instead of contacting another daemon", () => {
		const dir = join(tmpdir(), `daemon-badurl-${Date.now()}`);
		mkdirSync(dir, { recursive: true });
		writeFileSync(join(dir, "agent.yaml"), "daemon:\n  url: https://host.example/signet\n");
		const previous = process.env.SIGNET_DAEMON_URL;
		Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
		try {
			expect(() => createDaemonClient(3850, dir)).toThrow("daemon.url must point at the daemon origin");
		} finally {
			if (previous === undefined) Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
			else process.env.SIGNET_DAEMON_URL = previous;
			rmSync(dir, { recursive: true, force: true });
		}
	});

	test("fetchDaemonResult uses SIGNET_HOST and SIGNET_PORT when no daemon URL is configured", async () => {
		const previousUrl = process.env.SIGNET_DAEMON_URL;
		const previousHost = process.env.SIGNET_HOST;
		const previousPort = process.env.SIGNET_PORT;
		Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
		process.env.SIGNET_HOST = "192.168.0.60";
		process.env.SIGNET_PORT = "3850";
		let seenUrl = "";
		globalThis.fetch = async (input) => {
			seenUrl = String(input);
			return new Response(JSON.stringify({ ok: true }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});
		};

		try {
			const client = createDaemonClient(3000);
			await client.fetchDaemonResult("/api/status");

			expect(client.url).toBe("http://192.168.0.60:3850");
			expect(seenUrl).toBe("http://192.168.0.60:3850/api/status");
		} finally {
			if (previousUrl === undefined) Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
			else process.env.SIGNET_DAEMON_URL = previousUrl;
			if (previousHost === undefined) Reflect.deleteProperty(process.env, "SIGNET_HOST");
			else process.env.SIGNET_HOST = previousHost;
			if (previousPort === undefined) Reflect.deleteProperty(process.env, "SIGNET_PORT");
			else process.env.SIGNET_PORT = previousPort;
		}
	});

	test("rejects invalid SIGNET_PORT instead of falling back to the default port", () => {
		const previousUrl = process.env.SIGNET_DAEMON_URL;
		const previousPort = process.env.SIGNET_PORT;
		Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
		process.env.SIGNET_PORT = "nope";

		try {
			expect(() => createDaemonClient(3850)).toThrow("SIGNET_PORT must be an integer");
		} finally {
			if (previousUrl === undefined) Reflect.deleteProperty(process.env, "SIGNET_DAEMON_URL");
			else process.env.SIGNET_DAEMON_URL = previousUrl;
			if (previousPort === undefined) Reflect.deleteProperty(process.env, "SIGNET_PORT");
			else process.env.SIGNET_PORT = previousPort;
		}
	});

	test("secretApiCall returns structured failure when fetch rejects", async () => {
		globalThis.fetch = async () => {
			throw new Error("boom");
		};

		const client = createDaemonClient(3850);
		const result = await client.secretApiCall("GET", "/api/status");

		expect(result.ok).toBe(false);
		expect(result.data).toEqual({ error: "Could not reach Signet daemon" });
	});

	test("secretApiCall reports timeout failures accurately", async () => {
		globalThis.fetch = async () => {
			const err = new Error("timed out");
			Object.defineProperty(err, "name", { value: "TimeoutError" });
			throw err;
		};

		const client = createDaemonClient(3850);
		const result = await client.secretApiCall("POST", "/api/inference/execute", { prompt: "hi" }, 60000);

		expect(result.ok).toBe(false);
		expect(result.data).toEqual({ error: "Request timed out after 60000ms" });
	});

	test("secretApiCall falls back to text error payload when response is not json", async () => {
		globalThis.fetch = async () =>
			new Response("bad gateway", {
				status: 502,
				headers: { "Content-Type": "text/plain" },
			});

		const client = createDaemonClient(3850);
		const result = await client.secretApiCall("GET", "/api/status");

		expect(result.ok).toBe(false);
		expect(result.data).toEqual({ error: "bad gateway" });
	});

	test("secretApiCall returns parsed json on success", async () => {
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ ok: true, value: 42 }), {
				status: 200,
				headers: { "Content-Type": "application/json" },
			});

		const client = createDaemonClient(3850);
		const result = await client.secretApiCall("GET", "/api/status");

		expect(result.ok).toBe(true);
		expect(result.data).toEqual({ ok: true, value: 42 });
	});

	test("fetchDaemonResult classifies timeout failures separately from offline", async () => {
		globalThis.fetch = async () => {
			const err = new Error("timed out");
			Object.defineProperty(err, "name", { value: "TimeoutError" });
			throw err;
		};

		const client = createDaemonClient(3850);
		const result = await client.fetchDaemonResult("/api/hooks/session-start");

		expect(result).toEqual({ ok: false, reason: "timeout" });
	});

	test("fetchDaemonResult preserves http failures for callers that need accurate fallback handling", async () => {
		globalThis.fetch = async () =>
			new Response("bad gateway", {
				status: 502,
				headers: { "Content-Type": "text/plain" },
			});

		const client = createDaemonClient(3850);
		const result = await client.fetchDaemonResult("/api/hooks/session-start");

		expect(result).toEqual({ ok: false, reason: "http", status: 502 });
	});

	test("fetchDaemonResult preserves structured retry metadata from an HTTP failure", async () => {
		globalThis.fetch = async () =>
			new Response(JSON.stringify({ error: "writer failed", retryable: true, retryFrom: 20 }), {
				status: 503,
				headers: { "Content-Type": "application/json" },
			});

		const client = createDaemonClient(3850);
		const result = await client.fetchDaemonResult("/api/dream/tools/apply_ontology_ops");

		expect(result).toEqual({
			ok: false,
			reason: "http",
			status: 503,
			error: "writer failed",
			body: { error: "writer failed", retryable: true, retryFrom: 20 },
		});
	});
});
