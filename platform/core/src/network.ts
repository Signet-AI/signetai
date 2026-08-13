export const NETWORK_MODES = ["localhost", "tailscale"] as const;
export type NetworkMode = (typeof NETWORK_MODES)[number];

/** IPv4 loopback is the daemon's canonical local listener family. */
export const LOOPBACK_HOST = "127.0.0.1";

export function normalizeLoopbackHost(host: string): string {
	const normalized = host
		.trim()
		.toLowerCase()
		.replace(/^\[|\]$/g, "");
	return normalized === "localhost" || normalized === "::1" || normalized === "0:0:0:0:0:0:0:1" ? LOOPBACK_HOST : host;
}

const LOCAL_BINDS = new Set([LOOPBACK_HOST, "localhost", "::1", "::ffff:127.0.0.1"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

export function normalizeNetworkMode(value: unknown): NetworkMode | null {
	return value === "localhost" || value === "tailscale" ? value : null;
}

export function readNetworkMode(raw: unknown): NetworkMode {
	if (!isRecord(raw)) return "localhost";
	if (!isRecord(raw.network)) return "localhost";
	return normalizeNetworkMode(raw.network.mode) ?? "localhost";
}

export function networkModeFromBindHost(bind: string): NetworkMode {
	return LOCAL_BINDS.has(bind.trim().toLowerCase()) ? "localhost" : "tailscale";
}

export function resolveNetworkBinding(mode: NetworkMode): {
	readonly host: string;
	readonly bind: string;
} {
	if (mode === "tailscale") {
		return {
			host: LOOPBACK_HOST,
			bind: "0.0.0.0",
		};
	}

	return {
		host: LOOPBACK_HOST,
		bind: LOOPBACK_HOST,
	};
}
