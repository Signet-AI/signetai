/**
 * Selects who owns the daemon restart after an update.
 *
 * launchd's KeepAlive starts the next process as soon as this process exits.
 * Spawning a replacement ourselves races the single-instance lock, so the
 * old process must exit and release the lock before launchd respawns it.
 */
export type DaemonRestartMode = "service-manager" | "replacement";

export function resolveDaemonRestartMode(env: NodeJS.ProcessEnv = process.env): DaemonRestartMode {
	return env.SIGNET_DAEMON_SERVICE === "launchd" ? "service-manager" : "replacement";
}
