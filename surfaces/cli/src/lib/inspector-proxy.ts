import { spawn } from "node:child_process";
import type { ServerWebSocket } from "bun";

export interface InspectorEndpoint {
	readonly host: string;
	readonly port: number;
	readonly path: string;
}

export interface InspectorProxyOptions {
	readonly publicEndpoint: InspectorEndpoint;
	readonly targetEndpoint: InspectorEndpoint;
}

interface InspectorProxySocket {
	upstream: WebSocket | null;
	pending: Array<string | ArrayBuffer | Uint8Array>;
}

const INSPECTOR_TARGET_ID = "signet-daemon";
const INSPECTOR_PROTOCOL = {
	version: { major: "1", minor: "3" },
	domains: [],
} as const;

function endpointHost(host: string): string {
	if (host === "0.0.0.0" || host === "::") return "127.0.0.1";
	const normalized = host.replace(/^\[|\]$/g, "");
	return normalized.includes(":") ? `[${normalized}]` : normalized;
}

function validPort(port: number, value: string): number {
	if (!Number.isInteger(port) || port < 1 || port > 65535) {
		throw new Error(`Invalid inspector port: ${value}`);
	}
	return port;
}

export function parseInspectorEndpoint(value: string): InspectorEndpoint {
	const trimmed = value.trim();
	if (/^\d+(?:\/.*)?$/.test(trimmed)) {
		const [portText, ...pathParts] = trimmed.split("/");
		const port = validPort(Number(portText), value);
		return { host: "127.0.0.1", port, path: pathParts.length > 0 ? `/${pathParts.join("/")}` : "/" };
	}

	const parsed = new URL(trimmed.includes("://") ? trimmed : `http://${trimmed}`);
	const port = validPort(parsed.port.length > 0 ? Number(parsed.port) : 80, value);
	return {
		host: parsed.hostname.replace(/^\[|\]$/g, ""),
		port,
		path: parsed.pathname.length > 0 ? parsed.pathname : "/",
	};
}

export function formatInspectorEndpoint(endpoint: InspectorEndpoint, path = endpoint.path): string {
	return `${endpointHost(endpoint.host)}:${endpoint.port}${path.startsWith("/") ? path : `/${path}`}`;
}

export interface InspectorParentHandoff {
	readonly publicInspector: string;
	readonly environment: NodeJS.ProcessEnv;
}

/**
 * Bun binds BUN_INSPECT before application code runs. A native CLI parent
 * cannot bind a discovery proxy on that same port, so hand the command to a
 * second process with Bun's automatic inspector disabled and retain the
 * requested public endpoint for the daemon-start proxy.
 */
export function resolveInspectorParentHandoff(env: NodeJS.ProcessEnv = process.env): InspectorParentHandoff | null {
	const publicInspector = env.BUN_INSPECT?.trim();
	if (
		!publicInspector ||
		env.SIGNET_DAEMON_ENTRYPOINT === "1" ||
		env.SIGNET_INSPECTOR_HANDOFF === "1" ||
		env.SIGNET_INSPECTOR_PROXY_PUBLIC?.trim()
	) {
		return null;
	}
	return {
		publicInspector,
		environment: {
			...env,
			BUN_INSPECT: "",
			SIGNET_INSPECTOR_PUBLIC: publicInspector,
			SIGNET_INSPECTOR_HANDOFF: "1",
		},
	};
}

/** Re-exec the native CLI after releasing its parent-owned inspector socket. */
export function handoffInspectorParent(env: NodeJS.ProcessEnv = process.env): void {
	const handoff = resolveInspectorParentHandoff(env);
	if (!handoff) return;
	const child = spawn(process.execPath, process.argv.slice(1), {
		detached: true,
		stdio: "ignore",
		windowsHide: true,
		env: handoff.environment,
	});
	child.unref();
	process.exit(0);
}

function publicWebSocketUrl(endpoint: InspectorEndpoint): string {
	return `ws://${formatInspectorEndpoint(endpoint, "/json")}`;
}

function jsonResponse(value: unknown, status = 200): Response {
	return new Response(JSON.stringify(value), {
		status,
		headers: {
			"content-type": "application/json; charset=utf-8",
			"cache-control": "no-store",
		},
	});
}

function targetDescription(endpoint: InspectorEndpoint): Record<string, string> {
	return {
		description: "Signet Bun inspector target",
		devtoolsFrontendUrl: "",
		devtoolsFrontendUrlCompat: "",
		faviconUrl: "",
		id: INSPECTOR_TARGET_ID,
		title: "Signet daemon",
		type: "node",
		url: "file://signet-daemon",
		webSocketDebuggerUrl: publicWebSocketUrl(endpoint),
	};
}

function targetWebSocketUrl(endpoint: InspectorEndpoint): string {
	return `ws://${formatInspectorEndpoint(endpoint, "/json")}`;
}

function closeClient(client: ServerWebSocket<InspectorProxySocket>): void {
	if (client.readyState === 1) client.close(1011, "Inspector target disconnected");
}

function connectUpstream(client: ServerWebSocket<InspectorProxySocket>, endpoint: InspectorEndpoint): void {
	const upstream = new WebSocket(targetWebSocketUrl(endpoint));
	client.data.upstream = upstream;
	upstream.addEventListener("open", () => {
		for (const message of client.data.pending) upstream.send(message);
		client.data.pending = [];
	});
	upstream.addEventListener("message", (event) => {
		if (client.readyState !== 1) return;
		client.send(event.data as string | ArrayBuffer);
	});
	upstream.addEventListener("error", () => closeClient(client));
	upstream.addEventListener("close", () => closeClient(client));
}

export function createInspectorProxy(options: InspectorProxyOptions): Bun.Server<InspectorProxySocket> {
	const { publicEndpoint, targetEndpoint } = options;
	return Bun.serve<InspectorProxySocket>({
		hostname: publicEndpoint.host,
		port: publicEndpoint.port,
		fetch(request, server) {
			const path = new URL(request.url).pathname;
			if (path === "/json/version") {
				return fetch(`http://${formatInspectorEndpoint(targetEndpoint, "/json/version")}`)
					.then(async (response) => {
						if (!response.ok) return jsonResponse({ error: "Inspector target is unavailable" }, 503);
						const version = (await response.json()) as Record<string, unknown>;
						return jsonResponse({ ...version, webSocketDebuggerUrl: publicWebSocketUrl(publicEndpoint) });
					})
					.catch(() => jsonResponse({ error: "Inspector target is unavailable" }, 503));
			}
			if (path === "/json" || path === "/json/list") {
				if (request.headers.get("upgrade")?.toLowerCase() === "websocket") {
					if (server.upgrade(request, { data: { upstream: null, pending: [] } })) return;
					return new Response("WebSocket upgrade failed", { status: 400 });
				}
				return jsonResponse([targetDescription(publicEndpoint)]);
			}
			if (path === "/json/protocol") return jsonResponse(INSPECTOR_PROTOCOL);
			return new Response("Not Found", { status: 404 });
		},
		websocket: {
			open(client) {
				connectUpstream(client, targetEndpoint);
			},
			message(client, message) {
				const upstream = client.data.upstream;
				if (upstream?.readyState === WebSocket.OPEN) {
					upstream.send(message);
					return;
				}
				client.data.pending.push(message);
			},
			close(client) {
				client.data.upstream?.close();
				client.data.pending = [];
			},
		},
	});
}

export async function runInspectorProxy(options: InspectorProxyOptions): Promise<void> {
	let server: Bun.Server<InspectorProxySocket> | null = null;
	for (let attempt = 0; attempt < 120; attempt += 1) {
		try {
			server = createInspectorProxy(options);
			break;
		} catch (error) {
			if (!(error instanceof Error) || !error.message.includes("EADDRINUSE")) throw error;
			await Bun.sleep(250);
		}
	}
	if (!server) throw new Error(`Inspector proxy could not bind ${formatInspectorEndpoint(options.publicEndpoint)}`);

	let failedProbes = 0;
	const probeTimer = setInterval(async () => {
		try {
			const response = await fetch(`http://${formatInspectorEndpoint(options.targetEndpoint, "/json/version")}`);
			failedProbes = response.ok ? 0 : failedProbes + 1;
		} catch {
			failedProbes += 1;
		}
		if (failedProbes >= 12) {
			clearInterval(probeTimer);
			server?.stop(true);
			process.exit(0);
		}
	}, 1000);
}

export async function runInspectorProxyFromEnvironment(): Promise<void> {
	const publicValue = process.env.SIGNET_INSPECTOR_PROXY_PUBLIC;
	const targetValue = process.env.SIGNET_INSPECTOR_PROXY_TARGET;
	if (!publicValue || !targetValue) throw new Error("Inspector proxy endpoints are missing");
	await runInspectorProxy({
		publicEndpoint: parseInspectorEndpoint(publicValue),
		targetEndpoint: parseInspectorEndpoint(targetValue),
	});
}

if (import.meta.main) void runInspectorProxyFromEnvironment();
