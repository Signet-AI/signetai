import { spawn } from "node:child_process";

const TRANSCRIPT_RECOVERY_CHILD_GRACE_MS = 4_000;

async function main(): Promise<void> {
	const childPath = process.env.SIGNET_TRANSCRIPT_RECOVERY_CHILD_PATH;
	if (childPath === undefined) throw new Error("Transcript recovery supervisor child path is missing");
	const parentPid = process.ppid;

	const child = spawn(process.execPath, [childPath], {
		env: process.env,
		stdio: ["ignore", "pipe", "pipe"],
		detached: process.platform !== "win32",
	});
	child.stdout?.pipe(process.stdout);
	child.stderr?.pipe(process.stderr);
	if (child.pid !== undefined) process.stdout.write(`${JSON.stringify({ type: "started", pid: child.pid })}\n`);

	let killTimer: ReturnType<typeof setTimeout> | undefined;
	let parentWatch: ReturnType<typeof setInterval> | undefined;
	const killTarget = (): void => {
		if (child.pid === undefined) return;
		try {
			if (process.platform !== "win32") process.kill(-child.pid, "SIGKILL");
			else child.kill("SIGKILL");
		} catch {
			try {
				child.kill("SIGKILL");
			} catch {
				// The target may have exited between the check and escalation.
			}
		}
	};
	const forward = (signal: NodeJS.Signals): void => {
		if (process.platform !== "win32" && child.pid !== undefined) {
			try {
				process.kill(-child.pid, signal);
			} catch {
				// The target may have exited between the check and signal.
			}
		}
		try {
			child.kill(signal);
		} catch {
			// The target may have exited between the check and signal.
		}
		if (killTimer === undefined && (signal === "SIGTERM" || signal === "SIGINT")) {
			killTimer = setTimeout(killTarget, TRANSCRIPT_RECOVERY_CHILD_GRACE_MS);
		}
	};
	const closeAndExit = (): never => {
		if (parentWatch !== undefined) clearInterval(parentWatch);
		killTarget();
		process.exit(0);
	};
	parentWatch = setInterval(() => {
		// SIGKILL bypasses daemon cleanup; the supervisor owns the detached child group.
		if (process.ppid !== parentPid) closeAndExit();
	}, 50);
	parentWatch.unref();
	process.stdin.once("end", closeAndExit);
	process.stdin.once("close", closeAndExit);
	process.once("SIGTERM", () => forward("SIGTERM"));
	process.once("SIGINT", () => forward("SIGINT"));

	const [code, signal] = await new Promise<[number | null, NodeJS.Signals | null]>((resolve, reject) => {
		child.once("error", reject);
		child.once("close", (exitCode, exitSignal) => resolve([exitCode, exitSignal]));
	});
	if (killTimer !== undefined) clearTimeout(killTimer);
	if (signal !== null || code !== 0) process.exitCode = code ?? 1;
}

void main().catch((error: unknown) => {
	process.stderr.write(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
	process.exitCode = 1;
});
