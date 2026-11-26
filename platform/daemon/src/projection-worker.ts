import { parentPort } from "node:worker_threads";
import type { ProjectionInputRow } from "./umap-projection";
const port = parentPort;
if (!port) throw new Error("Projection requires a worker thread");
port.on("message", async (data: { rows: ProjectionInputRow[]; dimensions: 2 | 3 }) => {
	const { computeProjectionInput } = await import("./umap-projection");
	port.postMessage(computeProjectionInput(data.rows, data.dimensions));
});
