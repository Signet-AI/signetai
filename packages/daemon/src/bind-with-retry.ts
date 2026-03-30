import type { Server } from "node:net";
import { logger } from "./logger";

const DEFAULT_MAX_DELAY_MS = 30_000;
const DEFAULT_BASE_MS = 1000;

interface BindOptions {
	readonly port: number;
	readonly hostname: string;
	readonly maxDelayMs?: number;
	readonly baseDelayMs?: number;
	readonly createServer: () => Server;
	readonly onListening: (info: { address: string; port: number }) => void;
	readonly onBound: (server: Server) => void;
	readonly onFatalError?: (err: Error) => void;
	readonly schedule?: (fn: () => void, ms: number) => void;
}

/**
 * Bind an HTTP server with indefinite retry + capped exponential backoff
 * for EADDRINUSE so process-manager restarts (e.g. launchd KeepAlive)
 * that race with port release do not enter an infinite crash loop.
 *
 * EADDRINUSE retries forever in-process (delay caps at maxDelayMs).
 * Non-EADDRINUSE errors are forwarded to onFatalError (default: throw).
 *
 * The error handler is attached BEFORE listen() so EADDRINUSE is caught
 * before it becomes an uncaught exception.
 */
export function bindWithRetry(opts: BindOptions, attempt = 0): void {
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
			} catch {
				// Server may not have fully initialized — safe to ignore
			}
			schedule(() => bindWithRetry(opts, attempt + 1), delay);
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
