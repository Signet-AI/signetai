export type DaemonRestartMode = "service-manager" | "replacement";

export function resolveDaemonRestartMode(env: NodeJS.ProcessEnv = process.env): DaemonRestartMode {
	return env.SIGNET_DAEMON_SERVICE === "launchd" ? "service-manager" : "replacement";
}
