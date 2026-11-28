import { NodeTransport, type NodeTransportOptions, type ResolvedTarget } from "../../../../libs/sdk/src/node.js";
import { attempt, resolveDefaultBasePath } from "@signet/core";
import { cliSocket } from "./organization-target.js";
import { SignetError } from "../../../../libs/sdk/src/errors.js";
import { lstat } from "node:fs/promises";
import { request } from "node:http";
import { dirname } from "node:path";
import { once } from "node:events";
import { workspaceSocketPath } from "@signet/core/local-endpoint";

export function createCliNodeTransport(target: ResolvedTarget, options: NodeTransportOptions = {}): NodeTransport {
	return new NodeTransport(target, {
		...options,
		...(target.remote
			? {}
			: {
					fetch: async (url: string, init: RequestInit) => {
						const socket = await selectLocalSocket(resolveDefaultBasePath(), true, cliSocket());
						return socket ? socketFetch(socket, url, init) : fetch(url, init);
					},
				}),
	});
}

export async function selectLocalSocket(
	workspace: string,
	local: boolean,
	override?: string | false,
): Promise<string | undefined> {
	if (override === false) return undefined;
	if (!local) {
		if (override) throw new SignetError("--socket cannot target a remote instance", "local_socket_remote_target");
		return undefined;
	}
	if (process.platform === "win32") {
		if (override)
			throw new SignetError("Current-user-only local endpoint unavailable on Windows", "local_socket_unavailable");
		return undefined;
	}
	const path = override ?? attempt(() => workspaceSocketPath(workspace));
	if (!path) return undefined;
	try {
		const socket = await lstat(path);
		const directory = await lstat(dirname(path));
		if (
			!socket.isSocket() ||
			socket.uid !== process.getuid?.() ||
			(socket.mode & 0o777) !== 0o600 ||
			!directory.isDirectory() ||
			directory.isSymbolicLink() ||
			directory.uid !== process.getuid?.() ||
			(directory.mode & 0o777) !== 0o700
		)
			throw new SignetError("Unsafe local socket ownership, permissions, or type", "local_socket_unsafe");
		return path;
	} catch (error) {
		if (!override && error instanceof Error && "code" in error && error.code === "ENOENT") return undefined;
		if (error instanceof SignetError) throw error;
		throw new SignetError(
			error instanceof Error ? error.message : "Local socket unavailable",
			"local_socket_unavailable",
		);
	}
}
export async function socketFetch(socketPath: string, url: string, options: RequestInit = {}): Promise<Response> {
	const input = new Request(url, { ...options, ...(options.body instanceof ReadableStream ? { duplex: "half" } : {}) });
	return new Promise<Response>((resolve, reject) => {
		const target = new URL(url);
		const outgoing = request(
			{
				socketPath,
				path: `${target.pathname}${target.search}`,
				method: input.method,
				headers: { ...Object.fromEntries(input.headers), host: target.host },
				signal: options.signal ?? undefined,
			},
			(incoming) => {
				const headers = new Headers();
				for (const [key, value] of Object.entries(incoming.headers)) {
					if (Array.isArray(value)) for (const item of value) headers.append(key, item);
					else if (value !== undefined) headers.set(key, value);
				}
				const status = incoming.statusCode ?? 500;
				const bodyless = input.method === "HEAD" || [204, 205, 304].includes(status);
				if (bodyless) incoming.resume();
				const stream = bodyless
					? null
					: new ReadableStream<Uint8Array>({
							start(controller) {
								incoming.pause();
								incoming.on("data", (chunk: Buffer) => {
									controller.enqueue(new Uint8Array(chunk));
									incoming.pause();
								});
								incoming.on("end", () => controller.close());
								incoming.on("error", (error: Error) => controller.error(error));
							},
							pull() {
								incoming.resume();
							},
							cancel() {
								incoming.destroy();
							},
						});
				resolve(new Response(stream, { status, headers }));
			},
		);
		outgoing.once("error", reject);
		if (input.body) {
			const reader = input.body.getReader();
			void (async () => {
				try {
					for (;;) {
						const chunk = await reader.read();
						if (chunk.done) break;
						if (!outgoing.write(chunk.value)) await once(outgoing, "drain");
					}
					outgoing.end();
				} catch (error) {
					outgoing.destroy(error instanceof Error ? error : new Error(String(error)));
				} finally {
					reader.releaseLock();
				}
			})();
		} else outgoing.end();
	});
}
