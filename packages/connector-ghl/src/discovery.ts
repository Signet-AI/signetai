/**
 * GHL Entity Discovery
 *
 * Full account X-Ray — maps every entity in a GHL location:
 * pipelines, workflows, contacts (counts), tags, calendars,
 * funnels, users, custom fields, and opportunities.
 *
 * Ported from ghl-xray.mjs + ghl-signet-ingest.mjs in the
 * ghl-xray tooling project.
 */

import type {
	GHLApiOptions,
	GHLCalendar,
	GHLContact,
	GHLCustomField,
	GHLDiscoveryResult,
	GHLFunnel,
	GHLOAuthTokens,
	GHLOpportunity,
	GHLPipeline,
	GHLTag,
	GHLUser,
	GHLWorkflow,
} from "./types.js";
import type { GHLOAuthConfig } from "./types.js";
import { ghlApiFetch, ghlApiPaginate } from "./oauth.js";

// ============================================================================
// Main Discovery
// ============================================================================

export interface DiscoveryOptions {
	tokens: GHLOAuthTokens;
	config: GHLOAuthConfig;
	onRefreshed?: (tokens: GHLOAuthTokens) => Promise<void>;
	/** Log progress messages */
	onProgress?: (msg: string) => void;
}

/**
 * Run a full entity discovery on a GHL location.
 * Returns a structured GHLDiscoveryResult ready for memory ingestion.
 */
export async function discoverLocation(opts: DiscoveryOptions): Promise<GHLDiscoveryResult> {
	const { tokens, config, onRefreshed, onProgress } = opts;
	const apiOpts: GHLApiOptions = { tokens, config, onRefreshed };
	const locationId = tokens.locationId;
	const log = onProgress ?? (() => {});

	log(`Starting discovery for location ${locationId}`);

	// Run independent fetches in parallel where possible
	const [locationInfo, tags, users, customFields] = await Promise.all([
		fetchLocationInfo(locationId, apiOpts),
		fetchAllTags(locationId, apiOpts),
		fetchAllUsers(locationId, apiOpts),
		fetchCustomFields(locationId, apiOpts),
	]);

	log(`Location: ${locationInfo.name}`);
	log(`Tags: ${tags.length}, Users: ${users.length}, Custom Fields: ${customFields.length}`);

	const [pipelines, workflows, calendars, funnels] = await Promise.all([
		fetchAllPipelines(locationId, apiOpts),
		fetchAllWorkflows(locationId, apiOpts),
		fetchAllCalendars(locationId, apiOpts),
		fetchAllFunnels(locationId, apiOpts),
	]);

	log(`Pipelines: ${pipelines.length}, Workflows: ${workflows.length}`);
	log(`Calendars: ${calendars.length}, Funnels: ${funnels.length}`);

	// Contact counts (don't fetch all contacts — too large)
	const contactStats = await fetchContactStats(locationId, apiOpts);
	log(`Contacts: ${contactStats.total} total`);

	// Opportunity stats per pipeline
	const opportunityStats = await fetchOpportunityStats(locationId, pipelines, apiOpts);
	log(`Opportunities: ${opportunityStats.total} total`);

	const workflowsByStatus = categorizeWorkflows(workflows);

	return {
		locationId,
		locationName: locationInfo.name,
		discoveredAt: new Date().toISOString(),
		pipelines,
		workflows: {
			total: workflows.length,
			published: workflowsByStatus.published,
			draft: workflowsByStatus.draft,
			items: workflows,
		},
		contacts: {
			total: contactStats.total,
			tagged: contactStats.tagged,
			untagged: contactStats.untagged,
		},
		tags,
		calendars: {
			total: calendars.length,
			active: calendars.filter((c) => c.isActive).length,
			items: calendars,
		},
		funnels: {
			total: funnels.length,
			published: funnels.filter((f) => f.isPublished).length,
			items: funnels,
		},
		users,
		customFields,
		opportunities: opportunityStats,
	};
}

// ============================================================================
// Individual Fetchers
// ============================================================================

async function fetchLocationInfo(
	locationId: string,
	opts: GHLApiOptions
): Promise<{ name: string }> {
	const res = await ghlApiFetch(`/locations/${locationId}`, opts);
	if (!res.ok) return { name: locationId };
	const body = (await res.json()) as { location?: { name: string }; name?: string };
	return { name: body.location?.name ?? body.name ?? locationId };
}

async function fetchAllTags(locationId: string, opts: GHLApiOptions): Promise<GHLTag[]> {
	const res = await ghlApiFetch(`/locations/${locationId}/tags`, opts);
	if (!res.ok) return [];
	const body = (await res.json()) as { tags?: GHLTag[] };
	return body.tags ?? [];
}

async function fetchAllUsers(locationId: string, opts: GHLApiOptions): Promise<GHLUser[]> {
	const res = await ghlApiFetch(`/users/?locationId=${locationId}`, opts);
	if (!res.ok) return [];
	const body = (await res.json()) as { users?: GHLUser[] };
	return (body.users ?? []).map((u) => ({ ...u, locationIds: u.locationIds ?? [locationId] }));
}

async function fetchCustomFields(
	locationId: string,
	opts: GHLApiOptions
): Promise<GHLCustomField[]> {
	const res = await ghlApiFetch(`/locations/${locationId}/customFields`, opts);
	if (!res.ok) return [];
	const body = (await res.json()) as { customFields?: GHLCustomField[] };
	return body.customFields ?? [];
}

async function fetchAllPipelines(
	locationId: string,
	opts: GHLApiOptions
): Promise<GHLPipeline[]> {
	const res = await ghlApiFetch(`/opportunities/pipelines/?locationId=${locationId}`, opts);
	if (!res.ok) return [];
	const body = (await res.json()) as { pipelines?: GHLPipeline[] };
	return body.pipelines ?? [];
}

async function fetchAllWorkflows(
	locationId: string,
	opts: GHLApiOptions
): Promise<GHLWorkflow[]> {
	const all: GHLWorkflow[] = [];
	for await (const batch of ghlApiPaginate<GHLWorkflow>(
		`/workflows/?locationId=${locationId}`,
		opts
	)) {
		all.push(...batch);
	}
	return all;
}

async function fetchAllCalendars(
	locationId: string,
	opts: GHLApiOptions
): Promise<GHLCalendar[]> {
	const res = await ghlApiFetch(`/calendars/?locationId=${locationId}`, opts);
	if (!res.ok) return [];
	const body = (await res.json()) as { calendars?: GHLCalendar[] };
	return body.calendars ?? [];
}

async function fetchAllFunnels(locationId: string, opts: GHLApiOptions): Promise<GHLFunnel[]> {
	const res = await ghlApiFetch(`/funnels/funnel/list?locationId=${locationId}&limit=100`, opts);
	if (!res.ok) return [];
	const body = (await res.json()) as { funnels?: GHLFunnel[]; list?: GHLFunnel[] };
	return body.funnels ?? body.list ?? [];
}

async function fetchContactStats(
	locationId: string,
	opts: GHLApiOptions
): Promise<{ total: number; tagged: number; untagged: number }> {
	// Fetch a small page just to get total count
	const res = await ghlApiFetch(
		`/contacts/?locationId=${locationId}&limit=1`,
		opts
	);
	if (!res.ok) return { total: 0, tagged: 0, untagged: 0 };
	const body = (await res.json()) as { total?: number; meta?: { total?: number } };
	const total = body.total ?? body.meta?.total ?? 0;

	// Rough tagged estimate via a tagged query
	const taggedRes = await ghlApiFetch(
		`/contacts/?locationId=${locationId}&limit=1&query=*&includeCustomFields=false`,
		opts
	);
	const taggedBody = taggedRes.ok
		? ((await taggedRes.json()) as { total?: number })
		: { total: 0 };

	return {
		total,
		tagged: taggedBody.total ?? 0,
		untagged: Math.max(0, total - (taggedBody.total ?? 0)),
	};
}

async function fetchOpportunityStats(
	locationId: string,
	pipelines: GHLPipeline[],
	opts: GHLApiOptions
): Promise<GHLDiscoveryResult["opportunities"]> {
	const res = await ghlApiFetch(
		`/opportunities/search?location_id=${locationId}&limit=1`,
		opts
	);
	if (!res.ok) {
		return { total: 0, open: 0, won: 0, lost: 0, byPipeline: {} };
	}

	const body = (await res.json()) as {
		total?: number;
		meta?: { total?: number };
	};
	const total = body.total ?? body.meta?.total ?? 0;

	// Per-pipeline counts via small status queries
	const byPipeline: Record<string, { total: number; open: number }> = {};
	let globalOpen = 0;
	let globalWon = 0;
	let globalLost = 0;

	for (const pipeline of pipelines.slice(0, 20)) {
		// cap at 20 pipelines
		const pRes = await ghlApiFetch(
			`/opportunities/search?location_id=${locationId}&pipeline_id=${pipeline.id}&limit=1`,
			opts
		);
		if (!pRes.ok) continue;
		const pb = (await pRes.json()) as {
			total?: number;
			meta?: { total?: number };
		};
		const pTotal = pb.total ?? pb.meta?.total ?? 0;

		// Open count
		const openRes = await ghlApiFetch(
			`/opportunities/search?location_id=${locationId}&pipeline_id=${pipeline.id}&status=open&limit=1`,
			opts
		);
		const openBody = openRes.ok
			? ((await openRes.json()) as { total?: number; meta?: { total?: number } })
			: { total: 0 };
		const pOpen = openBody.total ?? 0;

		byPipeline[pipeline.id] = { total: pTotal, open: pOpen };
		globalOpen += pOpen;
	}

	// Won/lost are harder to count per-pipeline — rough totals via status filter
	const wonRes = await ghlApiFetch(
		`/opportunities/search?location_id=${locationId}&status=won&limit=1`,
		opts
	);
	if (wonRes.ok) {
		const wb = (await wonRes.json()) as { total?: number; meta?: { total?: number } };
		globalWon = wb.total ?? wb.meta?.total ?? 0;
	}

	const lostRes = await ghlApiFetch(
		`/opportunities/search?location_id=${locationId}&status=lost&limit=1`,
		opts
	);
	if (lostRes.ok) {
		const lb = (await lostRes.json()) as { total?: number; meta?: { total?: number } };
		globalLost = lb.total ?? lb.meta?.total ?? 0;
	}

	return {
		total,
		open: globalOpen || total - globalWon - globalLost,
		won: globalWon,
		lost: globalLost,
		byPipeline,
	};
}

// ============================================================================
// Helpers
// ============================================================================

function categorizeWorkflows(workflows: GHLWorkflow[]): {
	published: number;
	draft: number;
} {
	return workflows.reduce(
		(acc, wf) => {
			if (wf.status === "published") acc.published++;
			else acc.draft++;
			return acc;
		},
		{ published: 0, draft: 0 }
	);
}

/**
 * Compute a simple 0-100 health score from a discovery result.
 * Higher = healthier account.
 */
export function computeHealthScore(result: GHLDiscoveryResult): number {
	let score = 100;
	const deductions: Array<[boolean, number, string]> = [
		[result.pipelines.length === 0, 20, "no pipelines"],
		[result.workflows.published === 0, 15, "no published workflows"],
		[result.calendars.active === 0, 10, "no active calendars"],
		[result.funnels.published === 0, 10, "no published funnels/sites"],
		[result.tags.length === 0, 5, "no tags"],
		[result.users.length <= 1, 5, "single user"],
		[result.contacts.total === 0, 15, "no contacts"],
		[result.opportunities.open === 0 && result.contacts.total > 10, 10, "no open opportunities"],
		[result.customFields.length === 0, 5, "no custom fields"],
		[result.workflows.draft > result.workflows.published, 5, "more draft than published workflows"],
	];

	for (const [condition, penalty] of deductions) {
		if (condition) score -= penalty;
	}

	return Math.max(0, Math.min(100, score));
}
