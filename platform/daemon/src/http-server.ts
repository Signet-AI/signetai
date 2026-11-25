import type { ServerResponse } from "node:http";
import type { Server } from "node:net";
import { createAdaptorServer } from "@hono/node-server";

type AdaptorServerOptions = Parameters<typeof createAdaptorServer>[0];
export type SignetHttpServerOptions = AdaptorServerOptions;
interface HttpLifecycle {
	readonly pending: Set<ServerResponse>;
	closeWhenIdle: (() => void) | null;
	closing: Promise<boolean> | null;
}
const lifecycles = new WeakMap<Server, HttpLifecycle>();
export function closeSignetHttpServer(server: Server, deadlineMs = 15_000): Promise<boolean> {
	const state = lifecycles.get(server);
	if (!state) return Promise.reject(new Error("HTTP server has no lifecycle owner"));
	if (state.closing) return state.closing;
	state.closing = new Promise<boolean>((resolve, reject) => {
		let closed = false;
		const finish = (forced: boolean) => {
			if (closed) return;
			closed = true;
			clearTimeout(timer);
			state.closeWhenIdle = null;
			if ("closeAllConnections" in server && typeof server.closeAllConnections === "function")
				server.closeAllConnections();
			server.close((error?: Error) => {
				if (error && (!("code" in error) || error.code !== "ERR_SERVER_NOT_RUNNING")) reject(error);
				else resolve(forced);
			});
		};
		const timer = setTimeout(() => finish(true), deadlineMs);
		state.closeWhenIdle = () => {
			if (state.pending.size === 0) finish(false);
		};
		state.closeWhenIdle();
	});
	return state.closing;
}
export function createSignetHttpServer(opts: SignetHttpServerOptions): ReturnType<typeof createAdaptorServer> {
	const server = createAdaptorServer({ ...opts, overrideGlobalObjects: false });
	const state: HttpLifecycle = { pending: new Set(), closeWhenIdle: null, closing: null };
	lifecycles.set(server, state);
	server.prependListener("request", (_request: unknown, response: ServerResponse) => {
		state.pending.add(response);
		const complete = () => {
			if (!state.pending.delete(response)) return;
			state.closeWhenIdle?.();
		};
		response.once("finish", complete);
		response.once("close", complete);
	});
	return server;
}
