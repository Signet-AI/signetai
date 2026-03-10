/**
 * GHL → Signet Memory Ingestion
 *
 * Converts a GHL discovery result into structured Signet memories.
 * This gives the agent full account context from the moment it wakes up.
 *
 * Memory categories written:
 *   - account_overview  (1 memory, critical)
 *   - pipeline_entity   (N pipelines)
 *   - workflow_entity   (N workflows, batched)
 *   - tag_segment       (tag groups)
 *   - behavioral        (patterns inferred from account structure)
 *   - audit_run         (timestamped discovery snapshot)
 *
 * Ported from ghl-xray/scripts/ghl-signet-ingest.mjs
 */

import type { GHLDiscoveryResult, GHLGapAnalysisResult } from "./types.js";

// ============================================================================
// Signet SDK Types (minimal — avoids full SDK dep for now)
// ============================================================================

export interface SigNetMemory {
	content: string;
	type: string;
	tags?: string[];
	critical?: boolean;
	workspace?: string;
}

export interface SigNetClient {
	remember(memory: SigNetMemory): Promise<{ id: string }>;
	recall(query: string, limit?: number): Promise<Array<{ id: string; content: string }>>;
}

// ============================================================================
// HTTP Client for Signet Daemon
// ============================================================================

function buildSignetClient(daemonPort = 3850, token?: string): SigNetClient {
	const base = `http://localhost:${daemonPort}`;
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
	};
	if (token) headers["Authorization"] = `Bearer ${token}`;

	return {
		async remember(memory) {
			const res = await fetch(`${base}/api/memory/remember`, {
				method: "POST",
				headers,
				body: JSON.stringify(memory),
			});
			if (!res.ok) {
				const err = await res.text().catch(() => "");
				throw new Error(`Signet remember failed (${res.status}): ${err}`);
			}
			return res.json() as Promise<{ id: string }>;
		},

		async recall(query, limit = 10) {
			const res = await fetch(`${base}/api/memory/recall`, {
				method: "POST",
				headers,
				body: JSON.stringify({ query, limit }),
			});
			if (!res.ok) return [];
			const body = (await res.json()) as { memories?: Array<{ id: string; content: string }> };
			return body.memories ?? [];
		},
	};
}

// ============================================================================
// Ingest
// ============================================================================

export interface IngestOptions {
	daemonPort?: number;
	daemonToken?: string;
	workspace?: string;
	onProgress?: (msg: string) => void;
	/** Skip categories (for incremental re-sync) */
	skip?: Array<"overview" | "entities" | "behaviors" | "audit">;
}

export interface IngestResult {
	written: number;
	failed: number;
	errors: string[];
}

/**
 * Ingest a full discovery result into Signet memory.
 */
export async function ingestDiscovery(
	result: GHLDiscoveryResult,
	opts: IngestOptions = {}
): Promise<IngestResult> {
	const client = buildSignetClient(opts.daemonPort, opts.daemonToken);
	const log = opts.onProgress ?? (() => {});
	const skip = new Set(opts.skip ?? []);
	const ws = opts.workspace ?? "clawdbot";

	let written = 0;
	let failed = 0;
	const errors: string[] = [];

	async function write(memory: SigNetMemory) {
		try {
			await client.remember({ ...memory, workspace: ws });
			written++;
		} catch (e) {
			failed++;
			errors.push(String(e));
		}
	}

	// ── Account Overview ──────────────────────────────────────────────────────
	if (!skip.has("overview")) {
		log("Writing account overview...");
		await write({
			type: "ghl_account_overview",
			critical: true,
			tags: ["ghl", "account", result.locationId],
			content: buildOverviewMemory(result),
		});
	}

	// ── Entity Memories ───────────────────────────────────────────────────────
	if (!skip.has("entities")) {
		// Pipelines
		for (const pipeline of result.pipelines) {
			const stageNames = pipeline.stages.map((s) => s.name).join(" → ");
			await write({
				type: "ghl_pipeline",
				tags: ["ghl", "pipeline", result.locationId],
				content:
					`GHL Pipeline: "${pipeline.name}" (${result.locationName})\n` +
					`ID: ${pipeline.id}\n` +
					`Stages (${pipeline.stages.length}): ${stageNames}\n` +
					`Opportunities open: ${result.opportunities.byPipeline[pipeline.id]?.open ?? "unknown"}`,
			});
		}
		log(`Wrote ${result.pipelines.length} pipeline memories`);

		// Workflows (batch by status)
		const published = result.workflows.items.filter((w) => w.status === "published");
		const drafts = result.workflows.items.filter((w) => w.status !== "published");

		if (published.length > 0) {
			await write({
				type: "ghl_workflows_published",
				tags: ["ghl", "workflow", result.locationId],
				content: buildWorkflowBatchMemory(result.locationName, "published", published),
			});
		}

		if (drafts.length > 0) {
			await write({
				type: "ghl_workflows_draft",
				tags: ["ghl", "workflow", result.locationId],
				content: buildWorkflowBatchMemory(result.locationName, "draft/archived", drafts),
			});
		}
		log(`Wrote workflow memories (${published.length} published, ${drafts.length} draft)`);

		// Tags (grouped)
		if (result.tags.length > 0) {
			const tagChunks = chunkArray(result.tags, 50);
			for (let i = 0; i < tagChunks.length; i++) {
				await write({
					type: "ghl_tags",
					tags: ["ghl", "tag", result.locationId],
					content:
						`GHL Tags in ${result.locationName} (batch ${i + 1}/${tagChunks.length}):\n` +
						tagChunks[i]!.map((t) => `• ${t.name} [${t.id}]`).join("\n"),
				});
			}
		}

		// Calendars
		if (result.calendars.total > 0) {
			await write({
				type: "ghl_calendars",
				tags: ["ghl", "calendar", result.locationId],
				content:
					`GHL Calendars in ${result.locationName} (${result.calendars.active}/${result.calendars.total} active):\n` +
					result.calendars.items
						.map((c) => `• ${c.name} — ${c.isActive ? "active" : "inactive"}${c.calendarType ? ` (${c.calendarType})` : ""}`)
						.join("\n"),
			});
		}

		// Funnels/Sites
		if (result.funnels.total > 0) {
			await write({
				type: "ghl_funnels",
				tags: ["ghl", "funnel", result.locationId],
				content:
					`GHL Funnels/Sites in ${result.locationName} (${result.funnels.published}/${result.funnels.total} published):\n` +
					result.funnels.items
						.map((f) => `• [${f.type}] ${f.name} — ${f.isPublished ? "published" : "draft"}${f.url ? ` (${f.url})` : ""}`)
						.join("\n"),
			});
		}

		// Users
		await write({
			type: "ghl_users",
			tags: ["ghl", "user", result.locationId],
			content:
				`GHL Users in ${result.locationName} (${result.users.length} total):\n` +
				result.users.map((u) => `• ${u.name} — ${u.role} [${u.email}]`).join("\n"),
		});

		log(`Wrote entity memories`);
	}

	// ── Behavioral Memories ───────────────────────────────────────────────────
	if (!skip.has("behaviors")) {
		log("Writing behavioral inferences...");

		// Automation maturity
		const automationRatio =
			result.workflows.total > 0
				? result.workflows.published / result.workflows.total
				: 0;
		await write({
			type: "ghl_behavioral",
			tags: ["ghl", "behavior", "automation", result.locationId],
			content:
				`GHL Automation Maturity — ${result.locationName}:\n` +
				`${result.workflows.published} of ${result.workflows.total} workflows published (${Math.round(automationRatio * 100)}% active)\n` +
				(automationRatio < 0.3
					? "Assessment: Low automation adoption — significant opportunity to build workflows."
					: automationRatio < 0.7
						? "Assessment: Moderate automation — some gaps remain."
						: "Assessment: High automation adoption — account is well-automated."),
		});

		// Pipeline health
		if (result.pipelines.length > 0) {
			await write({
				type: "ghl_behavioral",
				tags: ["ghl", "behavior", "pipeline", result.locationId],
				content:
					`GHL Pipeline Health — ${result.locationName}:\n` +
					`${result.opportunities.open} open opportunities across ${result.pipelines.length} pipelines\n` +
					`Won: ${result.opportunities.won} | Lost: ${result.opportunities.lost}\n` +
					result.pipelines
						.map((p) => {
							const stats = result.opportunities.byPipeline[p.id];
							return `• "${p.name}": ${stats?.open ?? 0} open / ${stats?.total ?? 0} total`;
						})
						.join("\n"),
			});
		}
	}

	// ── Audit Snapshot ────────────────────────────────────────────────────────
	if (!skip.has("audit")) {
		log("Writing audit snapshot...");
		await write({
			type: "ghl_audit",
			tags: ["ghl", "audit", result.locationId],
			content:
				`GHL Account Audit — ${result.locationName}\n` +
				`Run: ${result.discoveredAt}\n` +
				`Contacts: ${result.contacts.total} | Open Deals: ${result.opportunities.open}\n` +
				`Workflows: ${result.workflows.published} published / ${result.workflows.draft} draft\n` +
				`Pipelines: ${result.pipelines.length} | Calendars: ${result.calendars.active} active\n` +
				`Funnels: ${result.funnels.published} published | Tags: ${result.tags.length}\n` +
				`Users: ${result.users.length} | Custom Fields: ${result.customFields.length}`,
		});
	}

	log(`Done: ${written} written, ${failed} failed`);
	return { written, failed, errors };
}

/**
 * Ingest a gap analysis result into Signet memory.
 */
export async function ingestGapAnalysis(
	analysis: GHLGapAnalysisResult,
	locationName: string,
	opts: IngestOptions = {}
): Promise<IngestResult> {
	const client = buildSignetClient(opts.daemonPort, opts.daemonToken);
	const ws = opts.workspace ?? "clawdbot";

	let written = 0;
	let failed = 0;
	const errors: string[] = [];

	const autoFixable = analysis.gaps.filter((g) => g.autoFixable);
	const humanReview = analysis.gaps.filter((g) => !g.autoFixable);
	const critical = analysis.gaps.filter((g) => g.severity === "critical");

	try {
		await client.remember({
			workspace: ws,
			type: "ghl_gap_analysis",
			critical: critical.length > 0,
			tags: ["ghl", "gaps", analysis.locationId],
			content:
				`GHL Gap Analysis — ${locationName}\n` +
				`Analyzed: ${analysis.analyzedAt}\n` +
				`Total Gaps: ${analysis.totalGaps} | Auto-fixable: ${analysis.autoFixable} | Human Review: ${analysis.humanReview}\n` +
				`Critical: ${analysis.critical} | Warning: ${analysis.warning} | Info: ${analysis.info}\n\n` +
				(critical.length > 0
					? `CRITICAL:\n${critical.map((g) => `• [${g.category}] ${g.title}: ${g.description}`).join("\n")}\n\n`
					: "") +
				(autoFixable.length > 0
					? `Auto-fixable:\n${autoFixable.map((g) => `• ${g.title}`).join("\n")}\n\n`
					: "") +
				(humanReview.length > 0
					? `Needs Human Review:\n${humanReview.map((g) => `• ${g.title}`).join("\n")}`
					: ""),
		});
		written++;
	} catch (e) {
		failed++;
		errors.push(String(e));
	}

	return { written, failed, errors };
}

// ============================================================================
// Memory Content Builders
// ============================================================================

function buildOverviewMemory(r: GHLDiscoveryResult): string {
	return [
		`GHL Account Overview — ${r.locationName}`,
		`Location ID: ${r.locationId}`,
		`Last Synced: ${r.discoveredAt}`,
		"",
		"── Contacts ──",
		`Total: ${r.contacts.total} | Tagged: ${r.contacts.tagged} | Untagged: ${r.contacts.untagged}`,
		"",
		"── Sales ──",
		`Pipelines: ${r.pipelines.length}`,
		`Open Deals: ${r.opportunities.open} | Won: ${r.opportunities.won} | Lost: ${r.opportunities.lost}`,
		r.pipelines.map((p) => `  • ${p.name} (${p.stages.length} stages)`).join("\n"),
		"",
		"── Automation ──",
		`Workflows: ${r.workflows.published} published / ${r.workflows.draft} draft / ${r.workflows.total} total`,
		"",
		"── Presence ──",
		`Funnels/Sites: ${r.funnels.published} live / ${r.funnels.total} total`,
		`Calendars: ${r.calendars.active} active / ${r.calendars.total} total`,
		"",
		"── Team ──",
		`Users: ${r.users.length}`,
		r.users.map((u) => `  • ${u.name} (${u.role})`).join("\n"),
		"",
		"── Data ──",
		`Tags: ${r.tags.length} | Custom Fields: ${r.customFields.length}`,
	]
		.filter((l) => l !== undefined)
		.join("\n");
}

function buildWorkflowBatchMemory(
	locationName: string,
	status: string,
	workflows: Array<{ id: string; name: string; status: string; updatedAt: string }>
): string {
	return (
		`GHL ${status.charAt(0).toUpperCase() + status.slice(1)} Workflows — ${locationName} (${workflows.length}):\n` +
		workflows
			.slice(0, 100) // cap at 100 per memory
			.map((w) => `• ${w.name} [${w.id}]`)
			.join("\n") +
		(workflows.length > 100 ? `\n... and ${workflows.length - 100} more` : "")
	);
}

function chunkArray<T>(arr: T[], size: number): T[][] {
	const chunks: T[][] = [];
	for (let i = 0; i < arr.length; i += size) {
		chunks.push(arr.slice(i, i + size));
	}
	return chunks;
}
