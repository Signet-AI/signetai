import { spawn, spawnSync, type ChildProcess } from "node:child_process";

interface SmokeProcess {
	readonly child: ChildProcess;
	readonly done: Promise<number>;
	readonly output: () => string;
	readonly stop: () => Promise<void>;
}

export function launchSmokeProcess(
	command: string,
	args: readonly string[],
	cwd: string,
	env: Record<string, string>,
): SmokeProcess {
	const child = spawn(command, [...args], {
		cwd,
		env,
		stdio: ["ignore", "pipe", "pipe"],
		windowsHide: true,
		detached: process.platform !== "win32",
	});
	let log = "";
	for (const stream of [child.stdout, child.stderr])
		stream?.on("data", (data) => {
			log = (log + String(data)).slice(-1_000_000);
		});
	const done = new Promise<number>((accept, reject) => {
		child.once("error", reject);
		child.once("close", (code) => accept(code ?? 1));
	});
	void done.catch(() => {});
	async function stop(): Promise<void> {
		const pid = child.pid;
		if (pid === undefined) {
			await done;
			return;
		}
		if (process.platform === "win32") {
			if (child.exitCode === null && child.signalCode === null) {
				const killed = spawnSync("taskkill", ["/PID", String(pid), "/T", "/F"], {
					windowsHide: true,
					timeout: 10_000,
					env,
				});
				if (killed.error || killed.status !== 0)
					throw new Error(`Installed process-tree cleanup failed: ${killed.stderr.toString()}`);
			}
		} else {
			for (const signal of ["SIGTERM", "SIGKILL"] as const) {
				try {
					process.kill(-pid, signal);
				} catch (error) {
					if (!(error instanceof Error) || !("code" in error) || error.code !== "ESRCH") throw error;
				}
				if (signal === "SIGTERM") await new Promise((accept) => setTimeout(accept, 250));
			}
		}
		let timer: ReturnType<typeof setTimeout> | undefined;
		try {
			await Promise.race([
				done,
				new Promise<never>((_, reject) => {
					timer = setTimeout(() => reject(new Error("Installed process-tree cleanup did not close its pipes")), 10_000);
				}),
			]);
		} finally {
			clearTimeout(timer);
		}
		if (process.platform !== "win32") {
			const checked = spawnSync("ps", ["-eo", "pgid=,stat="], { timeout: 5000, env });
			if (checked.error || checked.status !== 0) throw new Error("Cannot verify installed process group cleanup");
			const remaining = checked.stdout
				.toString()
				.split("\n")
				.some((line) => {
					const [group, state] = line.trim().split(/\s+/);
					return group === String(pid) && state !== undefined && !state.startsWith("Z");
				});
			if (remaining) throw new Error("Installed process group remains live after cleanup");
		}
	}
	return { child, done, output: () => log, stop };
}
