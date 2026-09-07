import { HARNESS_INSTALLERS } from "../harness-install-worker";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { Hono } from "hono";
import { requirePermission } from "../auth";
import { resolveEmbeddedWorkerPath } from "../native-runtime-assets";
import { AGENTS_DIR, authConfig } from "./state";

const SUPPORTED = new Set(Object.keys(HARNESS_INSTALLERS));
let installing = false;
let cancelInstall: (() => void) | undefined;
let installationClosed: Promise<void> = Promise.resolve();
const INSTALLATION_TIMEOUT_MS = 30_000;

function harnessInstallWorkerPath(): string {
	const embedded = resolveEmbeddedWorkerPath("harness-install-worker");
	if (embedded !== null) return embedded;
	const directory = dirname(fileURLToPath(import.meta.url));
	const built = join(directory, "harness-install-worker.js");
	return existsSync(built) ? built : join(directory, "../harness-install-worker.ts");
}

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
		await new Promise<void>((resolve, reject) => {
			if (signal.aborted) {
				reject(new Error("Installation cancelled"));
				return;
			}
			const workerOptions = {
				env: { ...process.env, SIGNET_PATH: AGENTS_DIR },
				type: "module",
				workerData: { id, workspace: AGENTS_DIR },
			} as const;
			const worker = new Worker(harnessInstallWorkerPath(), workerOptions);
			let stopped = "";
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (error?: Error) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				void worker
					.terminate()
					.catch(() => 0)
					.finally(() => (error ? reject(error) : resolve()));
			};
			const stop = (reason: string) => {
				if (stopped) return;
				stopped = reason;
				finish(new Error(reason));
			};
			const abort = () =>
				stop("Installation cancelled. Some integration files may have been written; retry to reconcile them.");
			timer = setTimeout(
				() => stop("Installation timed out. Retry to reconcile partially written integration files."),
				INSTALLATION_TIMEOUT_MS,
			);
			cancelInstall = abort;
			signal.addEventListener("abort", abort, { once: true });
			worker.on("message", (event: { readonly type?: string; readonly message?: string }) => {
				if (event.type === "complete") finish();
				else if (event.type === "error")
					finish(new Error(event.message || "Agent installation failed. Run signet doctor for details."));
			});
			worker.once("error", (error: Error) => {
				finish(new Error(stopped || error.message || "Agent installation failed. Run signet doctor for details."));
			});
			worker.once("exit", (code: number) => {
				if (settled) return;
				finish(
					new Error(
						stopped ||
							(code === 0
								? "Agent installation failed. Run signet doctor for details."
								: `Agent installation worker exited with code ${code}.`),
					),
				);
			});
			if (signal.aborted) abort();
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
