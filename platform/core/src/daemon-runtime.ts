export const DAEMON_RUNTIME_ENV = "SIGNET_DAEMON_RUNTIME" as const;

export const DAEMON_RUNTIME_VALUES = ["compiled", "bun-js"] as const;

export type DaemonRuntime = (typeof DAEMON_RUNTIME_VALUES)[number];

export const DEFAULT_DAEMON_RUNTIME: DaemonRuntime = "compiled";

export function parseDaemonRuntime(value: unknown): DaemonRuntime | null {
	if (typeof value !== "string") return null;
	const normalized = value;
	for (const runtime of DAEMON_RUNTIME_VALUES) {
		if (runtime === normalized) return runtime;
	}
	return null;
}

export function resolveDaemonRuntime(
	explicit: unknown = undefined,
	env: Readonly<Record<string, string | undefined>> = process.env,
): DaemonRuntime {
	const configured = explicit !== undefined ? explicit : env[DAEMON_RUNTIME_ENV];
	if (
		configured === undefined ||
		(explicit === undefined && typeof configured === "string" && configured.trim().length === 0)
	) {
		return DEFAULT_DAEMON_RUNTIME;
	}
	const parsed = parseDaemonRuntime(configured);
	if (parsed !== null) return parsed;
	throw new Error(
		`Unsupported daemon runtime ${JSON.stringify(configured)}. Choose one of: ${DAEMON_RUNTIME_VALUES.join(", ")}.`,
	);
}
