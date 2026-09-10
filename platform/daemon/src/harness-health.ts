import { existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnHidden as spawn } from "@signet/core";
import { HARNESS_INSTALLERS, getHarnessLoader, type HarnessConnectorStatus } from "./harness-registry";
import { hasNativeRuntimeAssets } from "./native-runtime-assets";

export interface HarnessHealthRequest {
	readonly id: string;
	readonly configured: boolean;
	readonly lastSeen: string | null;
}

const active = new Map<string, { cancel: () => void; closed: Promise<HarnessConnectorStatus> }>();
let stopping = false;

function workerPath(): string {
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

/** At most one child process per registered connector; every outcome waits for process cleanup. */
export async function runHarnessInspection(
	request: HarnessHealthRequest,
	options: { signal?: AbortSignal; timeoutMs?: number; entrypoint?: string } = {},
): Promise<HarnessConnectorStatus> {
	if (stopping || options.signal?.aborted) return failed(request, "Health inspection cancelled.");
	if (active.has(request.id)) return failed(request, "Health inspection already running; retry shortly.");
	let cancel = () => {};
	const closed = new Promise<HarnessConnectorStatus>((resolve) => {
		const child = spawn(
			process.execPath,
			hasNativeRuntimeAssets() && !options.entrypoint ? [] : [options.entrypoint ?? workerPath()],
			{
				env: { ...process.env, SIGNET_HEALTH_INSPECTION: JSON.stringify(request) },
				stdio: ["ignore", "pipe", "ignore"],
			},
		);
		let result: HarnessConnectorStatus | undefined;
		const finish = (status: HarnessConnectorStatus) => {
			if (result) return;
			result = status;
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", cancel);
			// A thread cannot interrupt a synchronous native read. A process can
			// be killed even when its connector is blocked opening a FIFO.
			child.kill("SIGKILL");
		};
		cancel = () => finish(failed(request, "Health inspection cancelled."));
		const timer = setTimeout(() => finish(failed(request, "Health inspection timed out.")), options.timeoutMs ?? 5000);
		options.signal?.addEventListener("abort", cancel, { once: true });
		let output = "";
		child.stdout?.setEncoding("utf8");
		child.stdout?.on("data", (chunk: string) => {
			output += chunk;
			if (output.length > 65536) return finish(failed(request, "Health inspection response exceeded its limit."));
			const prefix = "SIGNET_HEALTH_RESULT ";
			const start = output.indexOf(prefix);
			const end = output.indexOf("\n", start);
			if (start < 0 || end < 0) return;
			try {
				finish(JSON.parse(output.slice(start + prefix.length, end)) as HarnessConnectorStatus);
			} catch {
				finish(failed(request, "Health inspection returned an invalid response."));
			}
		});
		child.once("error", (error: Error) => finish(failed(request, `Health inspection failed: ${error.message}`)));
		child.once("close", (code) => {
			clearTimeout(timer);
			options.signal?.removeEventListener("abort", cancel);
			resolve(result ?? failed(request, `Health process exited before reporting a result (${code}).`));
		});
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
