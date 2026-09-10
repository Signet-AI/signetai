import { isMainThread, parentPort, workerData, Worker } from "node:worker_threads";
import { getHarnessLoader, inspectRegisteredConnector } from "./harness-registry";
import { resolveEmbeddedWorkerPath } from "./native-runtime-assets";
import type { HarnessHealthRequest } from "./harness-health";

if (!isMainThread && parentPort !== null) {
	const request = workerData as HarnessHealthRequest;
	const loader = getHarnessLoader(request.id);
	if (!loader) throw new Error("Unsupported harness connector");
	parentPort.postMessage(
		await inspectRegisteredConnector(
			request.id,
			loader,
			request.configured,
			request.lastSeen,
			new Date().toISOString(),
		),
	);
	parentPort.close();
} else if (process.env.SIGNET_HEALTH_INSPECTION !== undefined) {
	// Keep this child process's event loop free even when native connector I/O
	// blocks. Its own watchdog also bounds its life if the daemon is SIGKILLed.
	const request = JSON.parse(process.env.SIGNET_HEALTH_INSPECTION) as HarnessHealthRequest;
	setTimeout(() => process.exit(1), 5000);
	let reported = false;
	const worker = new Worker(resolveEmbeddedWorkerPath("harness-health-worker") ?? new URL(import.meta.url), {
		workerData: request,
	});
	worker.once("message", (status) => {
		reported = true;
		process.stdout.write(`SIGNET_HEALTH_RESULT ${JSON.stringify(status)}\n`, () => process.exit(0));
	});
	worker.once("error", () => process.exit(1));
	worker.once("exit", () => {
		if (!reported) process.exit(1);
	});
}
