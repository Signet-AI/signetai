import { type McpAnalyticsSummary, getMcpAnalytics } from "$lib/api";

export const mcpAnalytics = $state({
	data: null as McpAnalyticsSummary | null,
	loading: false,
	error: null as string | null,
});

export async function fetchMcpAnalytics(params?: {
	server?: string;
	since?: string;
}): Promise<void> {
	mcpAnalytics.loading = true;
	mcpAnalytics.error = null;
	try {
		mcpAnalytics.data = await getMcpAnalytics(params);
	} catch (error) {
		mcpAnalytics.error = error instanceof Error ? error.message : String(error);
		mcpAnalytics.data = null;
	} finally {
		mcpAnalytics.loading = false;
	}
}
