import { readFile } from "node:fs/promises";
import { promisify } from "node:util";
import { attemptAsync, execFileHidden, launchdDaemonLabel, launchdDaemonPlistPath } from "@signet/core";
import { z } from "zod";
import type { Principal } from "./auth/principal";
import { requireAdmin } from "./auth/organization-operations";
import { IdentityError } from "./auth/organization-store";
import { beginSupervisedRestart, settleSupervisedRestart, completeSupervisedRestart } from "./auth/organization-admin";
import { operatorActor, operatorRequest } from "./operator-jobs";
import { logger } from "./logger";
const execute = promisify(execFileHidden);
async function command(file: string, args: readonly string[]) {
	const result = await execute(file, [...args], {
		encoding: "utf8",
		timeout: 2000,
		maxBuffer: 16384,
		windowsHide: true,
	});
	return result.stdout;
}
interface Supervisor {
	readonly kind: "systemd" | "launchd";
	readonly id: string;
	readonly verify: () => Promise<boolean>;
	readonly restart: () => Promise<void>;
}
let supervisor: Supervisor | null = null;
let pending = false;
export function operatorRestartCapabilities() {
	return { supervisor: supervisor ? { kind: supervisor.kind } : null, restart: supervisor !== null };
}
export async function initializeOperatorRestart(agentsDir: string, shutdown: () => void) {
	supervisor = null;
	if (process.platform === "linux") {
		const cgroup = await attemptAsync(() =>
			readFile("/proc/self/cgroup", { encoding: "utf8", signal: AbortSignal.timeout(2000) }),
		);
		const path = cgroup
			?.split("\n")
			.find((line) => line.startsWith("0::"))
			?.slice(3);
		const unit = path?.split("/").at(-1);
		if (unit && path && /^[a-zA-Z0-9_.@\\-]{1,200}\.service$/.test(unit) && !unit.startsWith("user@")) {
			const args = path.startsWith("/user.slice/") ? ["--user"] : [];
			const verify = async () => {
				const text = await command("systemctl", [...args, "show", unit, "--property=MainPID,ControlGroup,ActiveState"]);
				const properties = Object.fromEntries(
					text
						.trim()
						.split("\n")
						.map((line) => {
							const i = line.indexOf("=");
							return [line.slice(0, i), line.slice(i + 1)];
						}),
				);
				return (
					properties.MainPID === String(process.pid) &&
					properties.ControlGroup === path &&
					properties.ActiveState === "active"
				);
			};
			if (await attemptAsync(verify))
				supervisor = {
					kind: "systemd",
					id: `systemd:${args.length ? "user" : "system"}:${unit}`,
					verify,
					restart: async () => {
						await command("systemctl", [...args, "--no-block", "restart", unit]);
					},
				};
		}
	} else if (
		process.platform === "darwin" &&
		process.env.SIGNET_DAEMON_SERVICE === "launchd" &&
		typeof process.getuid === "function"
	) {
		const label = launchdDaemonLabel(agentsDir),
			target = `gui/${process.getuid()}/${label}`,
			plist = launchdDaemonPlistPath(agentsDir);
		const verify = async () => {
			const state = await command("/bin/launchctl", ["print", target]);
			const settings = z
				.object({ Label: z.string(), KeepAlive: z.boolean() })
				.parse(JSON.parse(await command("/usr/bin/plutil", ["-convert", "json", "-o", "-", plist])));
			return settings.Label === label && settings.KeepAlive && new RegExp(`\\bpid = ${process.pid}\\b`).test(state);
		};
		if (await attemptAsync(verify))
			supervisor = {
				kind: "launchd",
				id: `launchd:${target}`,
				verify,
				restart: async () => {
					shutdown();
				},
			};
	}
}
export async function reconcileSupervisedRestart() {
	if (supervisor) await completeSupervisedRestart(supervisor.id);
}
export async function restartOrganization(p: Principal) {
	requireAdmin(p);
	if (p.boundAgentId !== null || p.allowedProjects !== null)
		throw new IdentityError(403, "permission", "Restart requires an unrestricted administrator");
	const actor = operatorActor(p);
	await operatorRequest({ op: "authorize-global", actor });
	const control = supervisor;
	if (!control || !(await attemptAsync(control.verify)))
		throw new IdentityError(
			409,
			"supervisor_required",
			"This daemon has no verified supervisor. Restart it on the instance host.",
		);
	if (pending) throw new IdentityError(409, "restart_pending");
	pending = true;
	let jobId: string;
	try {
		jobId = await beginSupervisedRestart(p, control.id);
	} catch (error) {
		pending = false;
		throw error;
	}
	const expire = async () => {
		const settled = await attemptAsync(async () => {
			await settleSupervisedRestart(jobId, "incomplete", p);
			return true;
		});
		if (!settled) logger.error("daemon", "Supervised restart settlement failed", undefined, { jobId });
		pending = false;
	};
	const confirmation = setTimeout(() => {
		void expire();
	}, 30_000);
	confirmation.unref?.();
	setTimeout(() => {
		void (async () => {
			let managerDispatchStarted = false;
			const dispatched = await attemptAsync(async () => {
				await operatorRequest({ op: "authorize-global", actor });
				if (!(await control.verify())) throw new Error("supervisor_changed");
				await settleSupervisedRestart(jobId, "running", p);
				managerDispatchStarted = true;
				await control.restart();
				return true;
			});
			if (!dispatched && !managerDispatchStarted) {
				clearTimeout(confirmation);
				await expire();
			}
		})();
	}, 250);
	return { accepted: true, jobId, status: "pending", supervisor: { kind: control.kind } };
}
