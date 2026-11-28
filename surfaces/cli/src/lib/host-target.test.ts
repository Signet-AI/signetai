import { expect, test } from "bun:test";
import { isHostDaemonReady, resolveHostOrigin } from "./host-target";

test("host listen origin resolves flag then port environment then URL then default", () => {
	const env = { SIGNET_PORT: "43121", SIGNET_DAEMON_URL: "http://127.0.0.1:43122" };
	expect(resolveHostOrigin("43120", env, 43123)).toBe("http://127.0.0.1:43120");
	expect(resolveHostOrigin(undefined, env, 43123)).toBe("http://127.0.0.1:43121");
	expect(resolveHostOrigin(undefined, { SIGNET_DAEMON_URL: env.SIGNET_DAEMON_URL }, 43123)).toBe(
		"http://127.0.0.1:43122",
	);
	expect(resolveHostOrigin(undefined, {}, 43123)).toBe("http://127.0.0.1:43123");
	expect(resolveHostOrigin(undefined, { SIGNET_DAEMON_URL: "http://localhost" }, 43123)).toBe("http://127.0.0.1:80");
	expect(resolveHostOrigin(undefined, { SIGNET_DAEMON_URL: "https://localhost" }, 43123)).toBe("http://127.0.0.1:443");
	for (const port of ["0", "65536", "-1", "1.5", "", "invalid"])
		expect(() => resolveHostOrigin(port, env, 43123)).toThrow("--port");
	expect(() =>
		resolveHostOrigin(undefined, { SIGNET_PORT: "invalid", SIGNET_DAEMON_URL: env.SIGNET_DAEMON_URL }, 43123),
	).toThrow("--port");
	expect(resolveHostOrigin("43120", { SIGNET_PORT: "invalid", SIGNET_DAEMON_URL: "invalid" }, 43123)).toBe(
		"http://127.0.0.1:43120",
	);
});

test("host readiness requires database readiness and the launched PID and workspace", async () => {
	let health = { pid: process.pid, agentsDir: "/isolated/workspace", db: true };
	const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => Response.json(health) });
	const origin = `http://127.0.0.1:${server.port}`;
	try {
		expect(await isHostDaemonReady(origin, process.pid, "/isolated/workspace")).toBe(true);
		health = { ...health, db: false };
		expect(await isHostDaemonReady(origin, process.pid, "/isolated/workspace")).toBe(false);
		health = { ...health, db: true };
		health = { ...health, pid: process.pid + 1 };
		await expect(isHostDaemonReady(origin, process.pid, "/isolated/workspace")).rejects.toThrow("launched daemon PID");
		health = { pid: process.pid, agentsDir: "/another/workspace", db: true };
		await expect(isHostDaemonReady(origin, process.pid, "/isolated/workspace")).rejects.toThrow("workspace");
	} finally {
		await server.stop(true);
	}
});
