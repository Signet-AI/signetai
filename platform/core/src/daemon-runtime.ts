export const DAEMON_RUNTIME_ENV = "SIGNET_DAEMON_RUNTIME" as const;
export const DAEMON_RUNTIME_VALUES = ["compiled"] as const;
export type DaemonRuntime = (typeof DAEMON_RUNTIME_VALUES)[number];
export const DEFAULT_DAEMON_RUNTIME: DaemonRuntime = "compiled";

export function parseDaemonRuntime(value: unknown): DaemonRuntime | null {
	return value === "compiled" ? "compiled" : null;
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
	if (configured === "compiled") return "compiled";
	throw new Error(
		`Unsupported daemon runtime ${JSON.stringify(configured)}. Only the native compiled daemon is supported.`,
	);
}
