export interface SignetDaemonUrlOptions {
	readonly env?: Record<string, string | undefined>;
	readonly defaultHost?: string;
	readonly defaultPort?: number;
}

function readEnv(env: Record<string, string | undefined>, name: string): string | undefined {
	const value = env[name];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

function normalizePort(raw: string | undefined, fallback: number): string {
	if (!raw) return String(fallback);
	if (!/^\d+$/.test(raw)) {
		throw new Error(`SIGNET_PORT must be an integer between 1 and 65535: ${raw}`);
	}
	const port = Number.parseInt(raw, 10);
	if (!Number.isFinite(port) || port < 1 || port > 65_535) {
		throw new Error(`SIGNET_PORT must be an integer between 1 and 65535: ${raw}`);
	}
	return String(port);
}

function bracketIpv6Host(host: string): string {
	if (host.startsWith("[") || !host.includes(":")) return host;
	return `[${host}]`;
}

function assertPlainHost(raw: string): void {
	if (raw.includes("/") || raw.includes("@") || raw.includes("?") || raw.includes("#")) {
		throw new Error(`SIGNET_HOST must be a hostname or IP address, not a URL: ${raw}`);
	}
	const host = raw.startsWith("[") && raw.endsWith("]") ? raw.slice(1, -1) : raw;
	if (host.includes(":")) {
		if (/^[0-9A-Fa-f:.]+$/.test(host)) return;
		throw new Error(`SIGNET_HOST must be a hostname or IP address: ${raw}`);
	}
	if (!/^[A-Za-z0-9]([A-Za-z0-9.-]*[A-Za-z0-9])?$/.test(host)) {
		throw new Error(`SIGNET_HOST must be a hostname or IP address: ${raw}`);
	}
}

function normalizeDaemonUrl(raw: string, source: string): string {
	let parsed: URL;
	try {
		parsed = new URL(raw);
	} catch {
		throw new Error(`${source} must be an http(s) URL: ${raw}`);
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
		throw new Error(`${source} must use http or https: ${raw}`);
	}
	if (parsed.username || parsed.password) {
		throw new Error(`${source} must not include username or password credentials`);
	}
	if (parsed.search || parsed.hash) {
		throw new Error(`${source} must not include query strings or fragments`);
	}
	if (parsed.pathname !== "/" && parsed.pathname !== "") {
		throw new Error(`${source} must point at the daemon origin, not a path: ${raw}`);
	}
	return parsed.toString().replace(/\/$/, "");
}

export function resolveSignetDaemonUrl(opts: SignetDaemonUrlOptions = {}): string {
	const env = opts.env ?? process.env;
	const fallbackHost = opts.defaultHost ?? "127.0.0.1";
	const fallbackPort = opts.defaultPort ?? 3850;
	const explicit = readEnv(env, "SIGNET_DAEMON_URL");
	if (explicit) return normalizeDaemonUrl(explicit, "SIGNET_DAEMON_URL");

	const host = readEnv(env, "SIGNET_HOST") ?? fallbackHost;
	assertPlainHost(host);
	const port = normalizePort(readEnv(env, "SIGNET_PORT"), fallbackPort);
	return normalizeDaemonUrl(`http://${bracketIpv6Host(host)}:${port}`, "SIGNET_HOST/SIGNET_PORT");
}
