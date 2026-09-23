export type DaemonLaunchCommand = string[] | string;

function isDaemonScriptArgument(value: unknown): value is string {
	if (typeof value !== "string") return false;
	const normalized = value.replaceAll("\\", "/");
	return (
		normalized === "daemon.ts" ||
		normalized === "platform/daemon/src/daemon.ts" ||
		normalized.endsWith("/platform/daemon/src/daemon.ts")
	);
}

export function replaceDaemonLaunch(command: DaemonLaunchCommand, daemonBinary: string): string[] | null {
	const argv = Array.isArray(command) ? command : [command];
	const scriptIndex = argv.findIndex((value) => isDaemonScriptArgument(value));
	if (scriptIndex < 0) return null;
	return [daemonBinary, ...argv.slice(scriptIndex + 1)];
}
