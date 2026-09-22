import { getPipelineStatus } from "../../shared/api.js";
import type { MemoryStats } from "../../shared/types.js";

export async function updateStats(
	stats: MemoryStats,
	memoriesEl: HTMLElement,
	embeddedEl: HTMLElement,
	pipelineEl: HTMLElement,
): Promise<void> {
	memoriesEl.textContent = String(stats.total);
	embeddedEl.textContent = String(stats.withEmbeddings);

	const pipeline = await getPipelineStatus();
	if (pipeline !== null) {
		const queue = pipeline.queue ?? 0;
		pipelineEl.textContent = queue > 0 ? String(queue) : "idle";
	} else {
		pipelineEl.textContent = "--";
	}
}
