import { appendFileSync, statSync } from "node:fs";
import { replaceDaemonLaunch, type DaemonLaunchCommand } from "./rust-baseline-proof-daemon-launch";

// biome-ignore lint/suspicious/noUndeclaredEnvVars: explicit native proof artifact
const rustBinary = process.env.SIGNET_RUST_DAEMON_BIN;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: adapter evidence sidecar
const evidenceFile = process.env.SIGNET_RUST_DAEMON_EVIDENCE_FILE;
// biome-ignore lint/suspicious/noUndeclaredEnvVars: adapter evidence nonce
const evidenceNonce = process.env.SIGNET_RUST_EVIDENCE_NONCE;
if (!rustBinary) throw new Error("SIGNET_RUST_DAEMON_BIN is required; refusing TypeScript daemon fallback");
const rustStat = statSync(rustBinary, { throwIfNoEntry: false });
if (!rustStat?.isFile() || (rustStat.mode & 0o111) === 0)
	throw new Error(`SIGNET_RUST_DAEMON_BIN is not an executable file: ${rustBinary}`);

function recordEvidence(
	transport: "spawn" | "spawnSync",
	original: DaemonLaunchCommand,
	replaced: string[],
	result: { pid?: number; exitCode?: number; success?: boolean; error?: unknown },
): void {
	if (!evidenceFile || !evidenceNonce) return;
	const pid = result.pid;
	if (transport === "spawn" && (!Number.isInteger(pid) || (pid as number) <= 0))
		throw new Error("Rust daemon spawn did not return a valid native child pid");
	if (
		transport === "spawnSync" &&
		(!Number.isInteger(pid) ||
			(pid as number) <= 0 ||
			typeof result.exitCode !== "number" ||
			typeof result.success !== "boolean" ||
			result.error !== undefined)
	)
		throw new Error("Rust daemon spawnSync did not return a valid native process result");
	appendFileSync(
		evidenceFile,
		`${JSON.stringify({
			backend: "rust-daemon",
			binary: rustBinary,
			nonce: evidenceNonce,
			transport,
			pid: pid ?? null,
			exitCode: result.exitCode ?? null,
			success: result.success ?? null,
			original,
			replaced,
			callerStack: new Error().stack ?? "",
			status: transport === "spawn" ? "native-created" : "native-completed",
		})}\n`,
	);
}

const originalSpawn = Bun.spawn.bind(Bun);
Bun.spawn = ((command: string[] | string, options?: Parameters<typeof Bun.spawn>[1]) => {
	const replaced = replaceDaemonLaunch(command, rustBinary);
	if (!replaced) return originalSpawn(command as never, options);
	const env = { ...(options?.env ?? process.env), SIGNET_DAEMON_BIN: rustBinary };
	const child = originalSpawn(replaced, { ...options, env });
	recordEvidence("spawn", command, replaced, { pid: (child as { pid?: number }).pid });
	return child;
}) as typeof Bun.spawn;

const originalSpawnSync = Bun.spawnSync.bind(Bun);
Bun.spawnSync = ((command: string[] | string, options?: Parameters<typeof Bun.spawnSync>[1]) => {
	const replaced = replaceDaemonLaunch(command, rustBinary);
	if (!replaced) return originalSpawnSync(command as never, options);
	const env = { ...(options?.env ?? process.env), SIGNET_DAEMON_BIN: rustBinary };
	const result = originalSpawnSync(replaced, { ...options, env });
	recordEvidence("spawnSync", command, replaced, {
		pid: (result as { pid?: number }).pid,
		exitCode: result.exitCode,
		success: (result as { success?: boolean }).success,
		error: (result as { error?: unknown }).error,
	});
	return result;
}) as typeof Bun.spawnSync;
