import { isMainThread, parentPort, workerData } from "node:worker_threads";
import { getHarnessLoader, inspectRegisteredConnector } from "./harness-registry";
import type { HarnessHealthRequest } from "./harness-health";

if (!isMainThread && parentPort !== null) {
	const request = workerData as HarnessHealthRequest;
	const loader = getHarnessLoader(request.id);
	if (!loader) throw new Error("Unsupported harness connector");
	const status = await inspectRegisteredConnector(
		request.id,
		loader,
		request.configured,
		request.lastSeen,
		new Date().toISOString(),
	);
	parentPort.postMessage(status);
	parentPort.close();
}
