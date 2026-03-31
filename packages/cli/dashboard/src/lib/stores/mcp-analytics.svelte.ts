import { type McpAnalyticsSummary, getMcpAnalytics } from "$lib/api";

export const mcpAnalytics = $state({
	data: null as McpAnalyticsSummary | null,
	loading: false,
	error: null as string | null,
});

let requestSeq = 0;

export async function fetchMcpAnalytics(params?: {
	server?: string;
	since?: string;
	agentId?: string;
}): Promise<void> {
	const seq = ++requestSeq;
	mcpAnalytics.loading = true;
	mcpAnalytics.error = null;
	try {
		const data = await getMcpAnalytics(params);
		if (seq !== requestSeq) return;
		mcpAnalytics.data = data;
	} catch (error) {
		if (seq !== requestSeq) return;
		mcpAnalytics.error = error instanceof Error ? error.message : String(error);
		mcpAnalytics.data = null;
	} finally {
		if (seq === requestSeq) mcpAnalytics.loading = false;
	}
}
