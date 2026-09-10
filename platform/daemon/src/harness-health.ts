import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { HARNESS_INSTALLERS, getHarnessLoader, type HarnessConnectorStatus } from "./harness-registry";
import { resolveEmbeddedWorkerPath } from "./native-runtime-assets";

export interface HarnessHealthRequest {
	readonly id: string;
	readonly configured: boolean;
	readonly lastSeen: string | null;
}

const active = new Map<string, { cancel: () => void; closed: Promise<HarnessConnectorStatus> }>();
let stopping = false;

function workerPath(): string {
	const embedded = resolveEmbeddedWorkerPath("harness-health-worker");
	if (embedded !== null) return embedded;
	const directory = dirname(fileURLToPath(import.meta.url));
	const built = join(directory, "harness-health-worker.js");
	return existsSync(built) ? built : join(directory, "harness-health-worker.ts");
}

function failed(request: HarnessHealthRequest, message: string): HarnessConnectorStatus {
	return {
		id: request.id,
		displayName: request.id,
		kind: "harness",
		description: "Harness connector",
		icon: null,
		available: false,
		configured: request.configured,
		detected: false,
		installed: false,
		// An incomplete inspection cannot establish irrelevance. Keep its failure visible.
		relevant: true,
		configPath: null,
		lastSeen: request.lastSeen,
		capabilities: { repair: false, reinitialize: false, reinitializeRequiresConfirmation: false },
		health: { status: "unhealthy", message, checkedAt: new Date().toISOString() },
	};
}

/** At most one worker per registered connector; every outcome waits for worker cleanup. */
export async function runHarnessInspection(
	request: HarnessHealthRequest,
	options: { signal?: AbortSignal; timeoutMs?: number; entrypoint?: string } = {},
): Promise<HarnessConnectorStatus> {
	if (stopping || options.signal?.aborted) return failed(request, "Health inspection cancelled.");
	if (active.has(request.id)) return failed(request, "Health inspection already running; retry shortly.");
	let cancel = () => {};
	const closed = new Promise<HarnessConnectorStatus>((resolve) => {
		let worker: Worker;
		try {
			worker = new Worker(options.entrypoint ?? workerPath(), { workerData: request });
		} catch (error) {
			resolve(failed(request, `Health worker failed: ${error instanceof Error ? error.message : String(error)}`));
			return;
		}
		let settled = false;
		const finish = (status: HarnessConnectorStatus) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", cancel);
			void worker.terminate().then(
				() => resolve(status),
				(error) => {
					resolve(failed(request, `Health worker cleanup failed: ${String(error)}`));
				},
			);
		};
		cancel = () => finish(failed(request, "Health inspection cancelled."));
		const timer = setTimeout(() => finish(failed(request, "Health inspection timed out.")), options.timeoutMs ?? 5000);
		options.signal?.addEventListener("abort", cancel, { once: true });
		worker.once("message", (status: HarnessConnectorStatus) => finish(status));
		worker.once("error", (error: Error) => finish(failed(request, `Health inspection failed: ${error.message}`)));
		worker.once("exit", (code) => finish(failed(request, `Health worker exited before reporting a result (${code}).`)));
	});
	active.set(request.id, { cancel, closed });
	try {
		return await closed;
	} finally {
		active.delete(request.id);
	}
}

export async function stopHarnessHealth(): Promise<void> {
	stopping = true;
	const pending = [...active.values()];
	for (const work of pending) work.cancel();
	await Promise.all(pending.map((work) => work.closed));
}

export async function inspectHarnessConnector(
	id: string,
	configuredHarnesses: readonly string[],
	lastSeen: ReadonlyMap<string, string> = new Map(),
	signal?: AbortSignal,
): Promise<HarnessConnectorStatus | null> {
	if (!getHarnessLoader(id)) return null;
	return runHarnessInspection(
		{ id, configured: configuredHarnesses.includes(id), lastSeen: lastSeen.get(id) ?? null },
		{ signal },
	);
}

export async function enumerateHarnessConnectors(
	configuredHarnesses: readonly string[],
	lastSeen: ReadonlyMap<string, string> = new Map(),
	signal?: AbortSignal,
): Promise<readonly HarnessConnectorStatus[]> {
	return Promise.all(
		Object.keys(HARNESS_INSTALLERS).map((id) =>
			runHarnessInspection(
				{ id, configured: configuredHarnesses.includes(id), lastSeen: lastSeen.get(id) ?? null },
				{ signal },
			),
		),
	);
}
