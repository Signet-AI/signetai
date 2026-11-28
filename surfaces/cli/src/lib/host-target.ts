import { createServer } from "node:net";

export function resolveHostOrigin(portFlag: string | undefined, env: NodeJS.ProcessEnv, defaultPort: number): string {
	let raw = portFlag ?? env.SIGNET_PORT;
	if (raw === undefined) {
		const url = env.SIGNET_DAEMON_URL === undefined ? undefined : new URL(env.SIGNET_DAEMON_URL);
		if (url && url.protocol !== "http:" && url.protocol !== "https:")
			throw new Error("SIGNET_DAEMON_URL must use HTTP or HTTPS");
		raw =
			url && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
				? url.port || (url.protocol === "https:" ? "443" : "80")
				: String(defaultPort);
	}
	if (!/^\d+$/.test(raw) || !Number.isSafeInteger(Number(raw)) || Number(raw) < 1 || Number(raw) > 65535)
		throw new Error("Host listen port must be an integer between 1 and 65535; choose --port <port>");
	return `http://127.0.0.1:${Number(raw)}`;
}

export async function assertHostPortAvailable(origin: string): Promise<void> {
	const port = Number(new URL(origin).port || "80");
	await new Promise<void>((resolve, reject) => {
		const server = createServer();
		server.once("error", (error) =>
			reject(new Error(`Cannot listen on port ${port}; choose an unused --port <port>`, { cause: error })),
		);
		server.listen({ host: "127.0.0.1", port, exclusive: true }, () =>
			server.close((error) => (error ? reject(error) : resolve())),
		);
	});
}

function pendingConnection(value: unknown, depth = 0): boolean {
	if (typeof value !== "object" || value === null) return false;
	if ("name" in value && value.name === "TimeoutError") return true;
	if (
		"code" in value &&
		(value.code === "ECONNREFUSED" || value.code === "ConnectionRefused" || value.code === "ECONNRESET")
	)
		return true;
	return depth < 3 && "cause" in value && pendingConnection(value.cause, depth + 1);
}

export async function isHostDaemonReady(origin: string, pid: number, agentsDir: string): Promise<boolean> {
	let response: Response;
	try {
		response = await fetch(`${origin}/health`, { signal: AbortSignal.timeout(1200) });
	} catch (error) {
		if (pendingConnection(error)) return false;
		throw error;
	}
	if (!response.ok) return false;
	const health: unknown = await response.json();
	if (
		typeof health !== "object" ||
		health === null ||
		!("pid" in health) ||
		health.pid !== pid ||
		!("agentsDir" in health) ||
		health.agentsDir !== agentsDir
	)
		throw new Error(
			`Port ${new URL(origin).port || "80"} readiness does not match the launched daemon PID and workspace; choose --port <port>`,
		);
	return true;
}
