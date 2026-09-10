import type { ConnectorRecoveryCapabilities, InstallResult } from "@signet/connector-base";
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import type { Hono } from "hono";
import { requirePermission } from "../auth";
import { getHarnessLoader, type HarnessAction } from "../harness-registry";
import type { HarnessInstallWorkerEvent, HarnessInstallWorkerRequest } from "../harness-install-worker";
import { resolveEmbeddedWorkerPath } from "../native-runtime-assets";
import { inspectHarnessConnector } from "../harness-health";
import { AGENTS_DIR, authConfig } from "./state";

let installing = false;
let cancelInstall: (() => void) | undefined;
let installationClosed: Promise<void> = Promise.resolve();
const INSTALLATION_TIMEOUT_MS = 30_000;

type RecoveryAction = Exclude<HarnessAction, "connect">;

function actionLabel(action: HarnessAction): string {
	if (action === "repair") return "Repair";
	if (action === "reinitialize") return "Reinitialize";
	return "Installation";
}

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
export async function installHarness(
	id: string,
	signal: AbortSignal,
	action: HarnessAction = "connect",
): Promise<InstallResult> {
	if (getHarnessLoader(id) === null)
		throw new Error("This agent is configured through signet setup --non-interactive --harness instead.");
	if (installing) throw new Error("An agent installation is already running. Try again when it finishes.");
	installing = true;
	let closed = () => {};
	installationClosed = new Promise<void>((resolve) => {
		closed = resolve;
	});
	try {
		return await new Promise<InstallResult>((resolve, reject) => {
			if (signal.aborted) {
				reject(new Error(`${actionLabel(action)} cancelled`));
				return;
			}
			const workerOptions = {
				env: { ...process.env, SIGNET_PATH: AGENTS_DIR },
				type: "module",
				workerData: { id, workspace: AGENTS_DIR, action } satisfies HarnessInstallWorkerRequest,
			} as const;
			const worker = new Worker(harnessInstallWorkerPath(), workerOptions);
			let stopped = "";
			let settled = false;
			let timer: ReturnType<typeof setTimeout> | undefined;
			const finish = (result?: InstallResult, error?: Error) => {
				if (settled) return;
				settled = true;
				if (timer) clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				void worker
					.terminate()
					.catch(() => 0)
					.finally(() =>
						error
							? reject(error)
							: resolve(result ?? { success: true, message: `${actionLabel(action)} completed.`, filesWritten: [] }),
					);
			};
			const stop = (reason: string) => {
				if (stopped) return;
				stopped = reason;
				finish(undefined, new Error(reason));
			};
			const abort = () =>
				stop(
					`${actionLabel(action)} cancelled. Some integration files may have been written; retry to reconcile them.`,
				);
			timer = setTimeout(
				() => stop(`${actionLabel(action)} timed out. Retry to reconcile partially written integration files.`),
				INSTALLATION_TIMEOUT_MS,
			);
			cancelInstall = abort;
			signal.addEventListener("abort", abort, { once: true });
			worker.on("message", (event: HarnessInstallWorkerEvent) => {
				if (event.type === "complete") finish(event.result);
				else if (event.type === "error")
					finish(
						undefined,
						new Error(event.message || `${actionLabel(action)} failed. Run signet doctor for details.`),
					);
			});
			worker.once("error", (error: Error) => {
				finish(
					undefined,
					new Error(stopped || error.message || `${actionLabel(action)} failed. Run signet doctor for details.`),
				);
			});
			worker.once("exit", (code: number) => {
				if (settled) return;
				finish(
					undefined,
					new Error(
						stopped ||
							(code === 0
								? `${actionLabel(action)} failed. Run signet doctor for details.`
								: `${actionLabel(action)} worker exited with code ${code}.`),
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
		if (getHarnessLoader(id) === null)
			return c.json({ error: "Unsupported agent; use the CLI to configure this integration." }, 400);
		if (installing) return c.json({ error: "Another agent installation is running." }, 409);
		try {
			await installHarness(id, c.req.raw.signal);
			return c.json({ success: true, id });
		} catch (error) {
			return c.json({ error: error instanceof Error ? error.message : "Installation failed" }, 500);
		}
	});

	const registerRecoveryRoute = (action: RecoveryAction) => {
		app.post(`/api/harnesses/:id/${action}`, requirePermission("admin", authConfig), async (c) => {
			const id = c.req.param("id");
			if (getHarnessLoader(id) === null) {
				return c.json({ error: "Unsupported agent; use the CLI to configure this integration." }, 400);
			}

			const connector = await inspectHarnessConnector(id, [], new Map(), c.req.raw.signal);
			if (!connector?.available)
				return c.json({ error: connector?.health.message ?? "Connector is unavailable." }, 503);
			const capabilities: ConnectorRecoveryCapabilities = connector.capabilities;
			if (!capabilities[action]) {
				return c.json({ error: `${actionLabel(action)} is not supported by this connector.` }, 400);
			}

			if (action === "reinitialize" && capabilities.reinitializeRequiresConfirmation) {
				let body: unknown = null;
				try {
					body = await c.req.json();
				} catch {
					// Missing or malformed confirmation is intentionally treated as no confirmation.
				}
				if (typeof body !== "object" || body === null || Array.isArray(body) || Reflect.get(body, "confirm") !== true) {
					return c.json(
						{
							error: "Reinitialize requires explicit confirmation because it may update connector-owned configuration.",
							confirmationRequired: true,
						},
						400,
					);
				}
			}

			if (installing) return c.json({ error: "Another connector action is already running." }, 409);
			try {
				const result = await installHarness(id, c.req.raw.signal, action);
				return c.json({
					success: true,
					id,
					action,
					message: result.message,
					warnings: result.warnings ?? [],
				});
			} catch (error) {
				return c.json(
					{
						success: false,
						id,
						action,
						error: error instanceof Error ? error.message : `${actionLabel(action)} failed`,
					},
					500,
				);
			}
		});
	};

	registerRecoveryRoute("repair");
	registerRecoveryRoute("reinitialize");
}
