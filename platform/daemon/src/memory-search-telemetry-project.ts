import type { RecallParams } from "./memory-search";

export function resolveMemorySearchTelemetryProject(params: Pick<RecallParams, "project">): string | null {
	const project = params.project?.trim();
	return project ? project : null;
}
