import {
	IDENTITY_MODES,
	IDENTITY_PRESETS,
	type IdentityContextFileEntry,
	type IdentityPresetName,
	type IdentitySpecialFileEntry,
	NETWORK_MODES,
} from "@signet/core";
import { z } from "zod";
import { aggregateRecallProviderIds, connectableProviderIds } from "./setup-inference-connect.js";
import {
	EMBEDDING_PROVIDER_CHOICES,
	EXTRACTION_PROVIDER_CHOICES,
	type ExtractionProviderChoice,
	OPENCLAW_RUNTIME_CHOICES,
	SETUP_HARNESS_CHOICES,
} from "./setup-shared.js";

/**
 * `SetupPlan` is the single typed, serializable seam for `signet setup`.
 *
 * It captures every decision the fresh-setup wizard makes — no prompts, no
 * side effects, no environment-derived values. Three frontends converge on it:
 * the interactive wizard, a headless `--json`/`--file` payload, and the plain
 * CLI flags. A validated plan is handed to {@link runFreshSetup} together with
 * a {@link SetupApplyContext} that carries the runtime/detected bits.
 *
 * Design note: the choice enums are derived from the existing readonly choice
 * arrays in `setup-shared.ts` so there is a single source of truth for the
 * allowed harness/provider values.
 */

const networkModeSchema = z.enum(NETWORK_MODES);
const harnessSchema = z.enum(SETUP_HARNESS_CHOICES);
const embeddingProviderSchema = z.enum(EMBEDDING_PROVIDER_CHOICES);
// Extraction provider accepts both the legacy CLI choices and the dashboard
// connect families (anthropic, openai-codex, github-copilot, …) — sourced from
// pi-ai's catalog, all valid routing executors the daemon handles.
const EXTRACTION_PROVIDER_IDS = [...new Set([...EXTRACTION_PROVIDER_CHOICES, ...connectableProviderIds()])] as const;
const extractionProviderSchema = z.enum(EXTRACTION_PROVIDER_IDS);
// Aggregate recall is pi-ai-only; accept any connectable pi-ai family + local servers.
const aggregateRecallProviderSchema = z.enum(aggregateRecallProviderIds());
const openclawRuntimeSchema = z.enum(OPENCLAW_RUNTIME_CHOICES);

const identityModeSchema = z.enum(IDENTITY_MODES);
const identityPresetSchema = z.enum(
	// IDENTITY_PRESETS is Record<IdentityPresetName, ...>, so its keys are exactly the preset names.
	Object.keys(IDENTITY_PRESETS) as [IdentityPresetName, ...IdentityPresetName[]],
);
const identitySessionKindSchema = z.enum(["dreaming", "heartbeat", "bootstrap"]);

const identityContextFileSchema = z.strictObject({
	path: z.string(),
	role: z.string().optional(),
	budget: z.number().optional(),
	enabled: z.boolean().optional(),
});

const identitySpecialFileSchema = identityContextFileSchema.extend({
	kind: identitySessionKindSchema,
});

// Single regex enforced identically by both parseSetupPlan (runtime) and the
// published --schema (pattern). Avoids zod .url(), whose constraint does not
// round-trip into z.toJSONSchema.
const httpEndpointSchema = z
	.string()
	.regex(/^https?:\/\/\S+$/, "must be an http:// or https:// URL")
	.describe("Required when extractionProvider is 'openai-compatible'")
	.optional();

/** A daemon URL is a bare origin, not an API path or credential-bearing URL. */
export const BARE_DAEMON_ORIGIN_PATTERN = /^https?:\/\/(?:[\w.-]+|\[[0-9A-Fa-f:.]+\])(?::\d+)?\/?$/;

export function isBareDaemonOrigin(value: string): boolean {
	if (!BARE_DAEMON_ORIGIN_PATTERN.test(value)) return false;
	try {
		const parsed = new URL(value);
		return (
			(parsed.protocol === "http:" || parsed.protocol === "https:") &&
			!parsed.username &&
			!parsed.password &&
			!parsed.search &&
			!parsed.hash &&
			(parsed.pathname === "/" || parsed.pathname === "")
		);
	} catch {
		return false;
	}
}

export const setupPlanSchema = z
	.strictObject({
		agentName: z.string(),
		agentDescription: z.string(),
		networkMode: networkModeSchema,
		harnesses: z.array(harnessSchema),
		openclawRuntimePath: openclawRuntimeSchema,
		configureOpenClawWs: z.boolean(),
		embeddingProvider: embeddingProviderSchema,
		embeddingModel: z.string(),
		embeddingDimensions: z.number().int().nonnegative(),
		extractionProvider: extractionProviderSchema,
		extractionModel: z.string(),
		extractionEndpoint: httpEndpointSchema,
		aggregateRecallProvider: aggregateRecallProviderSchema.optional(),
		aggregateRecallModel: z.string().optional(),
		aggregateRecallEndpoint: httpEndpointSchema,
		searchBalance: z.number().min(0).max(1),
		searchTopK: z.number().int().positive(),
		searchMinScore: z.number().min(0).max(1),
		memorySessionBudget: z.number().int().positive(),
		memoryDecayRate: z.number().min(0).max(1),
		gitEnabled: z.boolean(),
		signetSecretsEnabled: z.boolean(),
		graphiqEnabled: z.boolean(),
		identityMode: identityModeSchema,
		identityPreset: identityPresetSchema,
		startupIdentityFiles: z.array(identityContextFileSchema),
		specialIdentityFiles: z.array(identitySpecialFileSchema),
		dreamingEnabled: z.boolean().optional(),
		// Dashboard-style provider connect: when set, extraction runs on a connected
		// cloud provider (API key or OAuth). The modern inference.* route is the
		// source of truth; pipelineV2 stays enabled so the extraction worker runs.
		extractionConnect: z
			.strictObject({
				family: z.string(),
				connectMethod: z.enum(["api", "oauth"]),
			})
			.optional(),
		daemonUrl: z
			.string()
			// Match normalizeDaemonUrl's rules: a bare origin (no path, query,
			// fragment, or credentials) so a persisted daemon.url cannot brick the
			// module-load daemon client.
			.regex(BARE_DAEMON_ORIGIN_PATTERN, "must be a bare http(s) origin (no path, query, or credentials)")
			.optional(),
		sources: z
			.array(
				z.strictObject({
					type: z.literal("obsidian"),
					path: z.string(),
					name: z.string().optional(),
				}),
			)
			.optional(),
		agents: z
			.array(
				z.strictObject({
					name: z.string(),
					memoryPolicy: z.enum(["isolated", "shared", "group"]),
					memoryGroup: z.string().optional(),
				}),
			)
			.optional(),
	})
	.superRefine((plan, ctx) => {
		// The published regex admits bracketed IPv6 origins but cannot fully encode
		// IPv6 grammar. Apply URL parsing at the plan boundary too, so --file and
		// --json match the interactive/flag path rather than persisting a daemon
		// URL the runtime will reject.
		if (plan.daemonUrl && BARE_DAEMON_ORIGIN_PATTERN.test(plan.daemonUrl) && !isBareDaemonOrigin(plan.daemonUrl)) {
			ctx.addIssue({
				code: "custom",
				message: "must be a valid bare http(s) origin",
				path: ["daemonUrl"],
			});
		}
		// openai-compatible extraction has no implicit endpoint; the interactive
		// wizard defaults one, but a headless --file plan must state it.
		if (plan.extractionProvider === "openai-compatible" && !plan.extractionEndpoint) {
			ctx.addIssue({
				code: "custom",
				message: "openai-compatible extraction requires extractionEndpoint",
				path: ["extractionEndpoint"],
			});
		}
		// Aggregate recall is a distinct provider for query-time evidence
		// synthesis. It is pi-ai-only (no harness subprocess) and optional —
		// when unset it falls through to the default policy (extraction).
		if (plan.aggregateRecallProvider === "openai-compatible" && !plan.aggregateRecallEndpoint) {
			ctx.addIssue({
				code: "custom",
				message: "openai-compatible aggregate recall requires aggregateRecallEndpoint",
				path: ["aggregateRecallEndpoint"],
			});
		}
		if ((plan.aggregateRecallModel || plan.aggregateRecallEndpoint) && !plan.aggregateRecallProvider) {
			ctx.addIssue({
				code: "custom",
				message: "aggregateRecallModel/aggregateRecallEndpoint require aggregateRecallProvider",
				path: ["aggregateRecallProvider"],
			});
		}
		if (plan.aggregateRecallProvider && !plan.aggregateRecallModel?.trim()) {
			ctx.addIssue({
				code: "custom",
				message: "aggregateRecallProvider requires aggregateRecallModel",
				path: ["aggregateRecallModel"],
			});
		}
		// Aggregate recall synthesizes extracted memories at query time. With the
		// pipeline disabled (extraction none) there is nothing to synthesize, so a
		// distinct aggregate-recall provider would be dead config.
		if (plan.extractionProvider === "none" && plan.aggregateRecallProvider) {
			ctx.addIssue({
				code: "custom",
				message:
					"aggregateRecallProvider requires extraction to be enabled (nothing to synthesize without the extraction pipeline)",
				path: ["aggregateRecallProvider"],
			});
		}
		if (plan.extractionConnect) {
			if (!connectableProviderIds().includes(plan.extractionConnect.family)) {
				ctx.addIssue({
					code: "custom",
					message: `unknown connected provider "${plan.extractionConnect.family}"`,
					path: ["extractionConnect", "family"],
				});
			}
			if (plan.extractionConnect.family !== plan.extractionProvider) {
				ctx.addIssue({
					code: "custom",
					message: "extractionConnect.family must match extractionProvider",
					path: ["extractionConnect", "family"],
				});
			}
		}
		if (plan.agents) {
			const seen = new Set<string>();
			plan.agents.forEach((agent, i) => {
				if (agent.memoryPolicy === "group" && !agent.memoryGroup) {
					ctx.addIssue({
						code: "custom",
						message: "group memory policy requires memoryGroup",
						path: ["agents", i, "memoryGroup"],
					});
				}
				if (seen.has(agent.name)) {
					ctx.addIssue({
						code: "custom",
						message: `duplicate agent name "${agent.name}"`,
						path: ["agents", i, "name"],
					});
				}
				seen.add(agent.name);
			});
		}
	});

export type SetupPlan = z.infer<typeof setupPlanSchema>;

/**
 * Runtime/detected context that is NOT a user decision and therefore not part
 * of the serializable plan: where to apply, what was detected on disk, and how
 * the invocation should behave (interactive vs. headless, protection policy).
 */
export interface SetupApplyContext {
	readonly basePath: string;
	readonly existingAgentsDir: boolean;
	readonly nonInteractive: boolean;
	readonly allowUnprotectedWorkspace: boolean;
	readonly createLocalBackup: boolean;
	readonly availableExtractionProviders: readonly ExtractionProviderChoice[];
	readonly acpxBin?: string;
	readonly openclawConfigCount: number;
	readonly openDashboard: boolean;
	/** Run the provider connect (API-key entry / OAuth) against the now-running
	 * daemon. Provided by the interactive wizard; undefined for headless plans
	 * (the provider is connected later via the dashboard). */
	readonly connectExtraction?: () => Promise<boolean>;
}

/**
 * Parse and validate a raw (e.g. JSON-decoded) setup plan. Throws a structured
 * error listing every invalid field, so headless/agent callers get actionable
 * feedback instead of a raw zod stack.
 */
export function parseSetupPlan(json: unknown): SetupPlan {
	const result = setupPlanSchema.safeParse(json);
	if (result.success) {
		return result.data;
	}
	const issues = result.error.issues.map((issue) => {
		const path = issue.path.length > 0 ? issue.path.join(".") : "(root)";
		return `  - ${path}: ${issue.message}`;
	});
	throw new Error(`Invalid setup plan:\n${issues.join("\n")}`);
}

/** JSON Schema (draft 2020-12) for the setup plan, for `signet setup --schema`. */
export function setupPlanJsonSchema(): unknown {
	return z.toJSONSchema(setupPlanSchema);
}

// Re-export the entry types so callers of the plan API do not need a second
// import surface; the zod schemas mirror these core types exactly.
export type { IdentityContextFileEntry, IdentitySpecialFileEntry };
