import { AsyncLocalStorage } from "node:async_hooks";
import { chmod, lstat, mkdir, unlink } from "node:fs/promises";
import { createConnection } from "node:net";
import { userInfo } from "node:os";
import { dirname } from "node:path";
import { closeSignetHttpServer, createSignetHttpServer } from "./http-server";

export interface LocalTransportIdentity {
	readonly uid: number;
	readonly username: string;
}
const authority = new AsyncLocalStorage<LocalTransportIdentity>();
export function localTransportIdentity(): LocalTransportIdentity | undefined {
	return authority.getStore();
}
export type LocalEndpointStatus =
	| { readonly status: "available"; readonly path: string }
	| { readonly status: "unavailable"; readonly reason: string };
let status: LocalEndpointStatus = { status: "unavailable", reason: "not bound" };
export function localEndpointStatus(): LocalEndpointStatus {
	return status;
}

async function stale(path: string): Promise<void> {
	let before: Awaited<ReturnType<typeof lstat>>;
	try {
		before = await lstat(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	if (!before.isSocket() || before.uid !== process.getuid?.()) throw new Error("Unsafe local socket ownership or type");
	await new Promise<void>((resolve, reject) => {
		const probe = createConnection(path);
		probe.setTimeout(1000, () => {
			probe.destroy();
			reject(new Error("Local socket probe timed out"));
		});
		probe.once("connect", () => {
			probe.destroy();
			reject(new Error("Local socket is already listening"));
		});
		probe.once("error", (error) => {
			probe.destroy();
			if ("code" in error && error.code === "ECONNREFUSED") resolve();
			else reject(error);
		});
	});
	const after = await lstat(path);
	if (before.ino !== after.ino || before.dev !== after.dev || !after.isSocket() || after.uid !== process.getuid?.())
		throw new Error("Local socket changed during stale check");
	await unlink(path);
}

export async function bindLocalEndpoint(path: string, fetch: (request: Request) => Response | Promise<Response>) {
	if (process.platform === "win32" || !process.getuid) {
		status = { status: "unavailable", reason: "Current-user-only Windows pipe DACL is not supported" };
		throw new Error(status.reason);
	}
	if (Buffer.byteLength(path) >= (process.platform === "darwin" ? 104 : 108))
		throw new Error("Local socket path exceeds sun_path limit");
	const directory = dirname(path);
	const parent = await lstat(dirname(directory));
	if (
		!parent.isDirectory() ||
		parent.isSymbolicLink() ||
		(parent.uid !== process.getuid() && !(parent.uid === 0 && (parent.mode & 0o1000) !== 0)) ||
		((parent.mode & 0o022) !== 0 && !(parent.uid === 0 && (parent.mode & 0o1000) !== 0))
	)
		throw new Error("Unsafe local socket parent directory");
	try {
		await mkdir(directory, { mode: 0o700 });
	} catch (error) {
		if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
	}
	const dir = await lstat(directory);
	if (!dir.isDirectory() || dir.isSymbolicLink() || dir.uid !== process.getuid() || (dir.mode & 0o777) !== 0o700)
		throw new Error("Unsafe local socket directory");
	await stale(path);
	const identity = { uid: process.getuid(), username: userInfo().username };
	const server = createSignetHttpServer({ fetch: (request) => authority.run(identity, () => fetch(request)) });
	try {
		await new Promise<void>((resolve, reject) => {
			server.once("error", reject);
			server.listen(path, () => {
				server.removeListener("error", reject);
				resolve();
			});
		});
		await chmod(path, 0o600);
	} catch (error) {
		await closeSignetHttpServer(server);
		throw error;
	}
	const socket = await lstat(path);
	status = { status: "available", path };
	return {
		path,
		async close() {
			status = { status: "unavailable", reason: "stopped" };
			await closeSignetHttpServer(server);
			try {
				const current = await lstat(path);
				if (
					current.ino === socket.ino &&
					current.dev === socket.dev &&
					current.isSocket() &&
					current.uid === identity.uid
				)
					await unlink(path);
			} catch (error) {
				if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
			}
		},
	};
}
export function unavailableLocalEndpoint(reason: string): void {
	status = { status: "unavailable", reason };
}
