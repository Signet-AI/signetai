import { parentPort, workerData } from "node:worker_threads";
import { projectionTaskSchema } from "./embedding-projection-task";
import { computeProjectionFromRows } from "./umap-projection";

if (!parentPort) throw new Error("projection_worker_parent_required");
const request: unknown = workerData;
const input = projectionTaskSchema.parse(request);
parentPort.postMessage(computeProjectionFromRows(input.rows, input.dimensions));
parentPort.close();
