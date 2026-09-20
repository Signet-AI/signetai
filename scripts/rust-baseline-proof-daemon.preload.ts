const rustBinary = process.env.SIGNET_RUST_DAEMON_BIN;
if (!rustBinary) throw new Error("SIGNET_RUST_DAEMON_BIN is required; refusing TypeScript daemon fallback");
if (!Bun.file(rustBinary).exists()) throw new Error(`SIGNET_RUST_DAEMON_BIN does not exist: ${rustBinary}`);

const originalSpawn = Bun.spawn.bind(Bun);
Bun.spawn = ((command: string[] | string, options?: Parameters<typeof Bun.spawn>[1]) => {
	const argv = Array.isArray(command) ? command : [command];
	const isBaselineDaemonLaunch = argv.some((value) => value.endsWith("platform/daemon/src/daemon.ts"));
	if (!isBaselineDaemonLaunch) return originalSpawn(command as never, options);
	const env = { ...(options?.env ?? process.env), SIGNET_DAEMON_BIN: rustBinary };
	const replaced = [rustBinary];
	process.stderr.write(
		JSON.stringify({
			backend: "rust-daemon",
			binary: rustBinary,
			pid: process.pid,
			replaced: argv,
		}) + "\n",
	);
	return originalSpawn(replaced, { ...options, env });
}) as typeof Bun.spawn;
