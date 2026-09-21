import { appendFileSync } from "node:fs";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: explicit native proof artifact
const rustBinary = process.env.SIGNET_RUST_DAEMON_BIN;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: adapter evidence sidecar
const evidenceFile = process.env.SIGNET_RUST_DAEMON_EVIDENCE_FILE;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: adapter evidence nonce
const evidenceNonce = process.env.SIGNET_RUST_EVIDENCE_NONCE;
if (!rustBinary) throw new Error("SIGNET_RUST_DAEMON_BIN is required; refusing TypeScript daemon fallback");
if (!Bun.file(rustBinary).exists()) throw new Error(`SIGNET_RUST_DAEMON_BIN does not exist: ${rustBinary}`);

const originalSpawn = Bun.spawn.bind(Bun);
Bun.spawn = ((command: string[] | string, options?: Parameters<typeof Bun.spawn>[1]) => {
	const argv = Array.isArray(command) ? command : [command];
	const isBaselineDaemonLaunch =
		argv.length >= 2 && typeof argv[1] === "string" && argv[1].endsWith("platform/daemon/src/daemon.ts");
	if (!isBaselineDaemonLaunch) return originalSpawn(command as never, options);
	const env = { ...(options?.env ?? process.env), SIGNET_DAEMON_BIN: rustBinary };
	const replaced = [rustBinary];
	const child = originalSpawn(replaced, { ...options, env });
	if (evidenceFile && evidenceNonce) {
		appendFileSync(
			evidenceFile,
			`${JSON.stringify({ backend: "rust-daemon", binary: rustBinary, nonce: evidenceNonce, pid: process.pid, replaced: argv })}\n`,
		);
	}
	return child;
}) as typeof Bun.spawn;
