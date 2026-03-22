import chalk from "chalk";

export interface DaemonFetch {
	<T>(path: string, opts?: RequestInit & { timeout?: number }): Promise<T | null>;
}

export interface DaemonApiCall {
	(
		method: string,
		path: string,
		body?: unknown,
		timeoutMs?: number,
	): Promise<{ readonly ok: boolean; readonly data: unknown }>;
}

export function createDaemonClient(port: number): {
	readonly url: string;
	readonly fetchFromDaemon: DaemonFetch;
	readonly secretApiCall: DaemonApiCall;
} {
	const url = `http://localhost:${port}`;

	const fetchFromDaemon: DaemonFetch = async <T>(
		path: string,
		opts?: RequestInit & { timeout?: number },
	): Promise<T | null> => {
		const { timeout, ...fetchOpts } = opts || {};
		try {
			const res = await fetch(`${url}${path}`, {
				signal: AbortSignal.timeout(timeout || 5_000),
				...fetchOpts,
			});
			if (!res.ok) {
				return null;
			}
			const data: T = await res.json();
			return data;
		} catch {
			return null;
		}
	};

	const secretApiCall: DaemonApiCall = async (
		method: string,
		path: string,
		body?: unknown,
		timeoutMs = 5_000,
	): Promise<{ readonly ok: boolean; readonly data: unknown }> => {
		try {
			const res = await fetch(`${url}${path}`, {
				method,
				headers: body ? { "Content-Type": "application/json" } : {},
				body: body ? JSON.stringify(body) : undefined,
				signal: AbortSignal.timeout(timeoutMs),
			});
			const text = await res.text();
			let data: unknown;
			try {
				data = JSON.parse(text);
			} catch {
				data = { error: text || "Request failed" };
			}
			return { ok: res.ok, data };
		} catch {
			return {
				ok: false,
				data: { error: "Could not reach Signet daemon" },
			};
		}
	};

	return {
		url,
		fetchFromDaemon,
		secretApiCall,
	};
}

export async function ensureDaemonRunning(
	check: () => Promise<boolean>,
	msg = "  Daemon is not running. Start it with: signet daemon start",
): Promise<boolean> {
	const running = await check();
	if (running) {
		return true;
	}
	console.error(chalk.red(msg));
	return false;
}
