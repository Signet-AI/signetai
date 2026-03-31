import { type SkillAnalyticsSummary, getSkillAnalytics } from "$lib/api";

export const skillAnalytics = $state({
	data: null as SkillAnalyticsSummary | null,
	loading: false,
	error: null as string | null,
});

let requestSeq = 0;

export async function fetchSkillAnalytics(params?: {
	skill?: string;
	since?: string;
	agentId?: string;
}): Promise<void> {
	const seq = ++requestSeq;
	skillAnalytics.loading = true;
	skillAnalytics.error = null;
	try {
		const data = await getSkillAnalytics(params);
		if (seq !== requestSeq) return;
		skillAnalytics.data = data;
	} catch (error) {
		if (seq !== requestSeq) return;
		skillAnalytics.error = error instanceof Error ? error.message : String(error);
		skillAnalytics.data = null;
	} finally {
		if (seq === requestSeq) skillAnalytics.loading = false;
	}
}
