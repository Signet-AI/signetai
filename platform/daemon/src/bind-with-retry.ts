import type { Server } from "node:net";
import { logger } from "./logger";

const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_BASE_MS = 1000;

interface BindOptions {
	readonly port: number;
	readonly hostname: string;
	readonly maxDelayMs?: number;
	readonly baseDelayMs?: number;
	readonly signal?: AbortSignal;
	readonly createServer: () => Server;
	readonly onListening: (info: { address: string; port: number }) => void;
	readonly onBound: (server: Server) => void;
	readonly onFatalError?: (err: Error) => void;
	readonly schedule?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
}
export function bindWithRetry(opts: BindOptions, attempt = 0): void {
	if (opts.signal?.aborted) return;

	const maxDelay = opts.maxDelayMs ?? DEFAULT_MAX_DELAY_MS;
	const baseDelay = opts.baseDelayMs ?? DEFAULT_BASE_MS;
	const schedule = opts.schedule ?? setTimeout;
	const handleFatal =
		opts.onFatalError ??
		((err: Error) => {
			throw err;
		});
	const server = opts.createServer();

	server.on("error", (err: NodeJS.ErrnoException) => {
		if (err.code === "EADDRINUSE") {
			const delay = Math.min(baseDelay * 2 ** attempt, maxDelay);
			logger.warn("daemon", `Port ${opts.port} in use, retrying in ${delay}ms (attempt ${attempt + 1})`);
			try {
				server.close();
			} catch {}
			if (opts.signal?.aborted) return;
			const onAbort = (): void => clearTimeout(timer);
			const timer = schedule(() => {
				opts.signal?.removeEventListener("abort", onAbort);
				bindWithRetry(opts, attempt + 1);
			}, delay);
			opts.signal?.addEventListener("abort", onAbort, { once: true });
		} else {
			handleFatal(err);
		}
	});

	server.listen(opts.port, opts.hostname, () => {
		opts.onBound(server);
		const info = server.address();
		if (info && typeof info === "object") {
			opts.onListening(info);
		}
	});
}
