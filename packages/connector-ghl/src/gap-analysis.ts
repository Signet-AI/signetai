/**
 * GHL Gap Analysis Engine
 *
 * Inspects a discovery result for structural gaps and generates
 * a prioritized action plan: auto-fixable items and human-review items.
 *
 * Each gap has:
 *   - severity: critical | warning | info
 *   - autoFixable: whether the daemon can resolve it via API
 *   - fix: structured action payload (when autoFixable)
 *   - humanInstructions: what a human should do (when not autoFixable)
 *
 * Ported from ghl-xray/scripts/ghl-gap-filler.mjs
 */

import type {
	GapCategory,
	GHLDiscoveryResult,
	GHLGap,
	GHLGapAnalysisResult,
	GHLWorkflow,
} from "./types.js";

let gapCounter = 0;
function gapId(category: GapCategory): string {
	return `gap_${category}_${++gapCounter}`;
}

// ============================================================================
// Main Analyzer
// ============================================================================

/**
 * Analyze a discovery result for gaps.
 * Returns a structured gap analysis with auto-fixable + human-review buckets.
 */
export function analyzeGaps(result: GHLDiscoveryResult): GHLGapAnalysisResult {
	gapCounter = 0;
	const gaps: GHLGap[] = [];

	// Run all gap detectors
	gaps.push(...detectWorkflowGaps(result));
	gaps.push(...detectPipelineGaps(result));
	gaps.push(...detectCalendarGaps(result));
	gaps.push(...detectFunnelGaps(result));
	gaps.push(...detectContactGaps(result));
	gaps.push(...detectTagGaps(result));
	gaps.push(...detectUserGaps(result));

	const autoFixable = gaps.filter((g) => g.autoFixable).length;
	const humanReview = gaps.filter((g) => !g.autoFixable).length;

	return {
		locationId: result.locationId,
		analyzedAt: new Date().toISOString(),
		totalGaps: gaps.length,
		autoFixable,
		humanReview,
		critical: gaps.filter((g) => g.severity === "critical").length,
		warning: gaps.filter((g) => g.severity === "warning").length,
		info: gaps.filter((g) => g.severity === "info").length,
		gaps: sortGaps(gaps),
	};
}

// ============================================================================
// Gap Detectors
// ============================================================================

function detectWorkflowGaps(result: GHLDiscoveryResult): GHLGap[] {
	const gaps: GHLGap[] = [];

	// No published workflows at all
	if (result.workflows.total === 0) {
		gaps.push({
			id: gapId("workflow"),
			category: "workflow",
			severity: "critical",
			title: "No workflows configured",
			description:
				"This account has no automation workflows. Lead nurture, appointment reminders, and follow-ups are likely manual.",
			autoFixable: false,
			humanInstructions:
				"Create at least one lead nurture workflow and one appointment reminder workflow. Start with Templates in the Workflows section.",
		});
	} else if (result.workflows.published === 0) {
		gaps.push({
			id: gapId("workflow"),
			category: "workflow",
			severity: "critical",
			title: "All workflows are unpublished (draft)",
			description: `${result.workflows.total} workflow(s) exist but none are published — no automation is running.`,
			autoFixable: false,
			humanInstructions:
				"Review each draft workflow and publish the ones that are ready. Check trigger conditions before publishing.",
		});
	}

	// Workflows with no triggers (common naming-only creation pattern)
	const untriggeredPatterns = [
		/untitled/i,
		/new workflow/i,
		/copy of/i,
		/test/i,
		/draft/i,
	];
	const suspectWorkflows = result.workflows.items.filter(
		(w) =>
			w.status === "draft" &&
			untriggeredPatterns.some((p) => p.test(w.name))
	);
	if (suspectWorkflows.length > 0) {
		gaps.push({
			id: gapId("workflow"),
			category: "workflow",
			severity: "info",
			title: `${suspectWorkflows.length} suspect draft workflow(s) (likely test/untitled)`,
			description:
				"Found draft workflows with names suggesting they are test artifacts or abandoned.",
			autoFixable: false,
			humanInstructions: `Review and delete or rename: ${suspectWorkflows.map((w) => `"${w.name}"`).join(", ")}`,
		});
	}

	// More draft than published (imbalance)
	if (
		result.workflows.draft > result.workflows.published * 2 &&
		result.workflows.draft > 3
	) {
		gaps.push({
			id: gapId("workflow"),
			category: "workflow",
			severity: "warning",
			title: "High draft-to-published workflow ratio",
			description: `${result.workflows.draft} drafts vs ${result.workflows.published} published. Most automation work is incomplete.`,
			autoFixable: false,
			humanInstructions:
				"Audit draft workflows. Either finish and publish them or delete orphaned drafts.",
		});
	}

	// Missing core automation patterns (inferred from names)
	const publishedNames = result.workflows.items
		.filter((w) => w.status === "published")
		.map((w) => w.name.toLowerCase());

	const corePatterns: Array<{
		pattern: RegExp;
		name: string;
		triggerHint: string;
	}> = [
		{
			pattern: /lead\s*nurture|new\s*lead|lead\s*follow/,
			name: "Lead Nurture",
			triggerHint: "Contact Created trigger → sequence of follow-up messages",
		},
		{
			pattern: /appoint|booking|reminder/,
			name: "Appointment Reminder",
			triggerHint: "Appointment Status trigger → reminder SMS/email 24h before",
		},
		{
			pattern: /review|reputation|google/,
			name: "Review Request",
			triggerHint: "After job completion → ask for Google review",
		},
	];

	for (const pattern of corePatterns) {
		if (!publishedNames.some((n) => pattern.pattern.test(n))) {
			gaps.push({
				id: gapId("workflow"),
				category: "workflow",
				severity: "warning",
				title: `Missing: ${pattern.name} workflow`,
				description: `No published workflow matching "${pattern.name}" pattern detected.`,
				autoFixable: false,
				humanInstructions: `Create a ${pattern.name} workflow: ${pattern.triggerHint}`,
			});
		}
	}

	return gaps;
}

function detectPipelineGaps(result: GHLDiscoveryResult): GHLGap[] {
	const gaps: GHLGap[] = [];

	if (result.pipelines.length === 0) {
		gaps.push({
			id: gapId("pipeline"),
			category: "pipeline",
			severity: "critical",
			title: "No sales pipelines configured",
			description: "Without pipelines, there is no way to track deals or opportunities.",
			autoFixable: false,
			humanInstructions:
				"Create at least one pipeline. Typical stages: New Lead → Contacted → Qualified → Proposal Sent → Closed Won / Closed Lost",
		});
		return gaps;
	}

	// Pipelines with no stages
	for (const pipeline of result.pipelines) {
		if (pipeline.stages.length === 0) {
			gaps.push({
				id: gapId("pipeline"),
				category: "pipeline",
				severity: "critical",
				title: `Pipeline "${pipeline.name}" has no stages`,
				description: "An empty pipeline cannot hold opportunities.",
				autoFixable: false,
				entityId: pipeline.id,
				entityName: pipeline.name,
				humanInstructions: `Add stages to pipeline "${pipeline.name}" in the CRM settings.`,
			});
		} else if (pipeline.stages.length < 3) {
			gaps.push({
				id: gapId("pipeline"),
				category: "pipeline",
				severity: "info",
				title: `Pipeline "${pipeline.name}" has only ${pipeline.stages.length} stage(s)`,
				description: "Very few stages may indicate an incomplete sales process.",
				autoFixable: false,
				entityId: pipeline.id,
				entityName: pipeline.name,
				humanInstructions: `Consider adding more stages to "${pipeline.name}" to better track deal progress.`,
			});
		}
	}

	// Pipelines with stalled opportunities (zero open on a non-new pipeline)
	for (const pipeline of result.pipelines) {
		const stats = result.opportunities.byPipeline[pipeline.id];
		if (stats && stats.total > 5 && stats.open === 0) {
			gaps.push({
				id: gapId("pipeline"),
				category: "pipeline",
				severity: "warning",
				title: `Pipeline "${pipeline.name}" has no open opportunities`,
				description: `${stats.total} total deals but 0 currently open — pipeline may be stalled or incorrectly used.`,
				autoFixable: false,
				entityId: pipeline.id,
				entityName: pipeline.name,
				humanInstructions: `Review "${pipeline.name}" — are deals being moved to won/lost without following through? Consider an auto-close workflow.`,
			});
		}
	}

	return gaps;
}

function detectCalendarGaps(result: GHLDiscoveryResult): GHLGap[] {
	const gaps: GHLGap[] = [];

	if (result.calendars.total === 0) {
		gaps.push({
			id: gapId("calendar"),
			category: "calendar",
			severity: "warning",
			title: "No calendars configured",
			description: "No booking calendars found — appointment scheduling is unavailable.",
			autoFixable: false,
			humanInstructions:
				"Create at least one calendar. Set up availability, buffer times, and embed the booking link in your funnel.",
		});
	} else if (result.calendars.active === 0) {
		gaps.push({
			id: gapId("calendar"),
			category: "calendar",
			severity: "warning",
			title: "All calendars are inactive",
			description: `${result.calendars.total} calendar(s) exist but none are active.`,
			autoFixable: false,
			humanInstructions:
				"Enable at least one calendar and verify the booking link is working and embedded correctly.",
		});
	}

	return gaps;
}

function detectFunnelGaps(result: GHLDiscoveryResult): GHLGap[] {
	const gaps: GHLGap[] = [];

	if (result.funnels.total === 0) {
		gaps.push({
			id: gapId("funnel"),
			category: "funnel",
			severity: "warning",
			title: "No funnels or websites configured",
			description:
				"No landing pages or websites found — no digital presence configured in GHL.",
			autoFixable: false,
			humanInstructions:
				"Create at least one funnel with a lead capture page and a thank-you page.",
		});
	} else if (result.funnels.published === 0) {
		gaps.push({
			id: gapId("funnel"),
			category: "funnel",
			severity: "warning",
			title: "No published funnels/sites",
			description: `${result.funnels.total} funnel(s) configured but none are published/live.`,
			autoFixable: false,
			humanInstructions: "Publish at least one funnel and verify the live URL is accessible.",
		});
	}

	return gaps;
}

function detectContactGaps(result: GHLDiscoveryResult): GHLGap[] {
	const gaps: GHLGap[] = [];

	if (result.contacts.total === 0) {
		gaps.push({
			id: gapId("contact"),
			category: "contact",
			severity: "critical",
			title: "No contacts in account",
			description: "The account has no contacts — either brand new or data not imported.",
			autoFixable: false,
			humanInstructions:
				"Import your existing contacts via CSV or connect a lead source (Facebook Ads, landing page, etc.).",
		});
	} else if (result.contacts.total > 0 && result.contacts.untagged > result.contacts.total * 0.5) {
		gaps.push({
			id: gapId("contact"),
			category: "contact",
			severity: "info",
			title: "More than 50% of contacts are untagged",
			description:
				"Untagged contacts are harder to segment and automate. Workflows that trigger on tags won't reach them.",
			autoFixable: false,
			humanInstructions:
				"Run a bulk tag operation on existing contacts, or create a workflow that tags new contacts on entry.",
		});
	}

	return gaps;
}

function detectTagGaps(result: GHLDiscoveryResult): GHLGap[] {
	const gaps: GHLGap[] = [];

	if (result.tags.length === 0) {
		gaps.push({
			id: gapId("tag"),
			category: "tag",
			severity: "info",
			title: "No tags defined",
			description:
				"Tags power segmentation and workflow triggers. Without them, automation is limited.",
			autoFixable: true,
			fix: {
				type: "add_tag",
				payload: { name: "New Lead" },
			},
			humanInstructions:
				"Add foundational tags: 'New Lead', 'Appointment Booked', 'Customer', 'Cold Lead'",
		});
	}

	return gaps;
}

function detectUserGaps(result: GHLDiscoveryResult): GHLGap[] {
	const gaps: GHLGap[] = [];

	// Check for users with no role (API sometimes returns empty role)
	const noRole = result.users.filter((u) => !u.role);
	if (noRole.length > 0) {
		gaps.push({
			id: gapId("user"),
			category: "user",
			severity: "info",
			title: `${noRole.length} user(s) with undefined roles`,
			description: "Users without roles may have unexpected permission levels.",
			autoFixable: false,
			humanInstructions: `Review and assign roles to: ${noRole.map((u) => u.name).join(", ")}`,
		});
	}

	return gaps;
}

// ============================================================================
// Helpers
// ============================================================================

const SEVERITY_ORDER: Record<string, number> = {
	critical: 0,
	warning: 1,
	info: 2,
};

function sortGaps(gaps: GHLGap[]): GHLGap[] {
	return [...gaps].sort((a, b) => {
		const s = (SEVERITY_ORDER[a.severity] ?? 3) - (SEVERITY_ORDER[b.severity] ?? 3);
		if (s !== 0) return s;
		// Auto-fixable first within same severity
		return (b.autoFixable ? 1 : 0) - (a.autoFixable ? 1 : 0);
	});
}

/**
 * Execute auto-fixable gaps via GHL API.
 * Returns results for each attempted fix.
 */
export async function executeAutoFixes(
	analysis: GHLGapAnalysisResult,
	tokens: { access_token: string; locationId: string },
	opts: { dryRun?: boolean; onProgress?: (msg: string) => void } = {}
): Promise<Array<{ gapId: string; success: boolean; error?: string }>> {
	const results: Array<{ gapId: string; success: boolean; error?: string }> = [];
	const log = opts.onProgress ?? (() => {});

	const autoFixable = analysis.gaps.filter((g) => g.autoFixable && g.fix);

	for (const gap of autoFixable) {
		if (!gap.fix) continue;
		log(`${opts.dryRun ? "[DRY RUN] " : ""}Fixing: ${gap.title}`);

		if (opts.dryRun) {
			results.push({ gapId: gap.id, success: true });
			continue;
		}

		try {
			await applyFix(gap, tokens);
			results.push({ gapId: gap.id, success: true });
		} catch (e) {
			results.push({ gapId: gap.id, success: false, error: String(e) });
		}
	}

	return results;
}

async function applyFix(
	gap: GHLGap,
	tokens: { access_token: string; locationId: string }
): Promise<void> {
	const fix = gap.fix!;
	const base = "https://services.leadconnectorhq.com";
	const headers = {
		Authorization: `Bearer ${tokens.access_token}`,
		"Content-Type": "application/json",
		Version: "2021-07-28",
	};

	switch (fix.type) {
		case "add_tag": {
			const res = await fetch(`${base}/locations/${tokens.locationId}/tags`, {
				method: "POST",
				headers,
				body: JSON.stringify({ name: fix.payload.name }),
			});
			if (!res.ok) throw new Error(`Add tag failed: ${await res.text()}`);
			break;
		}

		case "update_workflow_status": {
			const res = await fetch(
				`${base}/workflows/${fix.payload.workflowId}`,
				{
					method: "PUT",
					headers,
					body: JSON.stringify({ status: fix.payload.status }),
				}
			);
			if (!res.ok) throw new Error(`Update workflow failed: ${await res.text()}`);
			break;
		}

		default:
			throw new Error(`Unknown fix type: ${(fix as { type: string }).type}`);
	}
}
