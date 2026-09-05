import { HARNESS_INSTALLERS } from "../harness-install-worker";
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Hono } from "hono";
import { requirePermission } from "../auth";
import { resolveEmbeddedWorkerPath } from "../native-runtime-assets";
import { AGENTS_DIR, authConfig } from "./state";

const SUPPORTED = new Set(Object.keys(HARNESS_INSTALLERS));
let installing = false;
let cancelInstall: (() => void) | undefined;
let installationClosed: Promise<void> = Promise.resolve();

export async function stopHarnessInstall(): Promise<void> {
	cancelInstall?.();
	await installationClosed;
}

/** One bounded adapter install at a time; completion waits for process cleanup. */
export async function installHarness(id: string, signal: AbortSignal): Promise<void> {
	if (!SUPPORTED.has(id))
		throw new Error("This agent is configured through signet setup --non-interactive --harness instead.");
	if (installing) throw new Error("An agent installation is already running. Try again when it finishes.");
	installing = true;
	let closed = () => {};
	installationClosed = new Promise<void>((resolve) => {
		closed = resolve;
	});
	try {
		const directory = dirname(fileURLToPath(import.meta.url));
		const built = join(directory, "harness-install-worker.js");
		const args =
			resolveEmbeddedWorkerPath("harness-install-worker") !== null
				? []
				: [existsSync(built) ? built : join(directory, "../harness-install-worker.ts")];
		await new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(new Error("Installation cancelled"));
				return;
			}
			const child = spawn(process.execPath, args, {
				env: { ...process.env, SIGNET_PATH: AGENTS_DIR, SIGNET_INSTALL_HARNESS: id },
				stdio: ["ignore", "pipe", "pipe"],
				windowsHide: true,
				detached: process.platform !== "win32",
			});
			let output = "",
				error = "",
				stopped = "";
			let killTimer: ReturnType<typeof setTimeout> | undefined;
			const kill = (signal: NodeJS.Signals) => {
				try {
					if (process.platform !== "win32" && child.pid) process.kill(-child.pid, signal);
					else child.kill(signal);
				} catch (error) {
					if (!(error instanceof Error && "code" in error && error.code === "ESRCH")) throw error;
				}
			};
			const stop = (reason: string) => {
				if (stopped) return;
				stopped = reason;
				kill("SIGTERM");
				killTimer = setTimeout(() => kill("SIGKILL"), 2_000);
			};
			const abort = () =>
				stop("Installation cancelled. Some integration files may have been written; retry to reconcile them.");
			const timer = setTimeout(
				() => stop("Installation timed out. Retry to reconcile partially written integration files."),
				30_000,
			);
			cancelInstall = abort;
			signal.addEventListener("abort", abort, { once: true });
			child.stdout.on("data", (chunk) => {
				output = (output + String(chunk)).slice(-32_768);
			});
			child.stderr.on("data", (chunk) => {
				error = (error + String(chunk)).slice(-4_096);
			});
			child.on("error", (e) => {
				error = e.message;
			});
			child.on("close", (code) => {
				clearTimeout(timer);
				clearTimeout(killTimer);
				signal.removeEventListener("abort", abort);
				if (!stopped && code === 0 && output.includes("SIGNET_INSTALL_RESULT ")) resolve();
				else reject(new Error(stopped || error || "Agent installation failed. Run signet doctor for details."));
			});
		});
	} finally {
		installing = false;
		cancelInstall = undefined;
		closed();
	}
}

export function registerHarnessInstallRoutes(app: Hono): void {
	app.post("/api/harnesses/:id/connect", requirePermission("admin", authConfig), async (c) => {
		const id = c.req.param("id");
		if (!SUPPORTED.has(id))
			return c.json({ error: "Unsupported agent; use the CLI to configure this integration." }, 400);
		if (installing) return c.json({ error: "Another agent installation is running." }, 409);
		try {
			await installHarness(id, c.req.raw.signal);
			return c.json({ success: true, id });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Installation failed" }, 500);
		}
	});
}
