import { type SkillAnalyticsSummary, getSkillAnalytics } from "$lib/api";

export const skillAnalytics = $state({
	data: null as SkillAnalyticsSummary | null,
	loading: false,
	error: null as string | null,
});

export async function fetchSkillAnalytics(params?: {
	skill?: string;
	since?: string;
}): Promise<void> {
	skillAnalytics.loading = true;
	skillAnalytics.error = null;
	try {
		skillAnalytics.data = await getSkillAnalytics(params);
	} catch (error) {
		skillAnalytics.error = error instanceof Error ? error.message : String(error);
		skillAnalytics.data = null;
	} finally {
		skillAnalytics.loading = false;
	}
}
