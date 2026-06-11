import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
	type NetworkMode,
	networkModeFromBindHost,
	parseSimpleYaml,
	readNetworkMode,
	resolveNetworkBinding,
} from "@signet/core";

export interface DaemonNetworkInfo {
	readonly bindHost?: string | null;
	readonly networkMode?: string | null;
}

function readEnv(value: string | undefined): string | null {
	if (typeof value !== "string") return null;
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : null;
}

export function readConfiguredNetworkMode(dir: string): NetworkMode {
	for (const name of ["agent.yaml", "AGENT.yaml"]) {
		const path = join(dir, name);
		if (!existsSync(path)) continue;
		try {
			return readNetworkMode(parseSimpleYaml(readFileSync(path, "utf8")));
		} catch {
			// Ignore malformed config and keep scanning fallbacks.
		}
	}

	return "localhost";
}

export function resolveDaemonNetwork(
	dir: string,
	env: Record<string, string | undefined>,
): {
	readonly host: string;
	readonly bind: string;
	readonly mode: NetworkMode;
} {
	const cfg = resolveNetworkBinding(readConfiguredNetworkMode(dir));
	const host = readEnv(env.SIGNET_HOST) ?? cfg.host;
	const bind = readEnv(env.SIGNET_BIND) ?? (readEnv(env.SIGNET_HOST) ? host : cfg.bind);

	return {
		host,
		bind,
		mode: networkModeFromBindHost(bind),
	};
}

export function daemonAccessLines(port: number, info?: DaemonNetworkInfo | NetworkMode | null): string[] {
	const mode =
		typeof info === "string"
			? info
			: typeof info?.networkMode === "string"
				? info.networkMode === "tailscale"
					? "tailscale"
					: "localhost"
				: info?.bindHost
					? networkModeFromBindHost(info.bindHost)
					: "localhost";

	const lines = [`Dashboard: http://localhost:${port}`];
	if (mode === "tailscale") {
		lines.push(`Tailnet: this machine's Tailscale IP on port ${port} (bind 0.0.0.0)`);
	}
	return lines;
}
