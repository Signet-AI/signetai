import type { ProjectionInputRow } from "./umap-projection";
declare const self: Worker;
self.onmessage = async (event: MessageEvent<{ rows: ProjectionInputRow[]; dimensions: 2 | 3 }>) => {
	const { computeProjectionInput } = await import("./umap-projection");
	self.postMessage(computeProjectionInput(event.data.rows, event.data.dimensions));
};
