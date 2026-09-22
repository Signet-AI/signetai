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

const networkModeSchema = z.enum(NETWORK_MODES);
const harnessSchema = z.enum(SETUP_HARNESS_CHOICES);
const embeddingProviderSchema = z.enum(EMBEDDING_PROVIDER_CHOICES);
const EXTRACTION_PROVIDER_IDS = [...new Set([...EXTRACTION_PROVIDER_CHOICES, ...connectableProviderIds()])] as const;
const extractionProviderSchema = z.enum(EXTRACTION_PROVIDER_IDS);
const aggregateRecallProviderSchema = z.enum(aggregateRecallProviderIds());
const openclawRuntimeSchema = z.enum(OPENCLAW_RUNTIME_CHOICES);

const identityModeSchema = z.enum(IDENTITY_MODES);
const identityPresetSchema = z.enum(Object.keys(IDENTITY_PRESETS) as [IdentityPresetName, ...IdentityPresetName[]]);
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
const httpEndpointSchema = z
	.string()
	.regex(/^https?:\/\/\S+$/, "must be an http:// or https:// URL")
	.describe("Required when extractionProvider is 'openai-compatible'")
	.optional();
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
		daemonUrl: z
			.string()
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
		if (plan.daemonUrl && BARE_DAEMON_ORIGIN_PATTERN.test(plan.daemonUrl) && !isBareDaemonOrigin(plan.daemonUrl)) {
			ctx.addIssue({
				code: "custom",
				message: "must be a valid bare http(s) origin",
				path: ["daemonUrl"],
			});
		}
		if (plan.extractionProvider === "openai-compatible" && !plan.extractionEndpoint) {
			ctx.addIssue({
				code: "custom",
				message: "openai-compatible extraction requires extractionEndpoint",
				path: ["extractionEndpoint"],
			});
		}
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
		if (plan.extractionProvider === "none" && plan.aggregateRecallProvider) {
			ctx.addIssue({
				code: "custom",
				message:
					"aggregateRecallProvider requires extraction to be enabled (nothing to synthesize without the extraction pipeline)",
				path: ["aggregateRecallProvider"],
			});
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
}
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
export function setupPlanJsonSchema(): unknown {
	return z.toJSONSchema(setupPlanSchema);
}
export type { IdentityContextFileEntry, IdentitySpecialFileEntry };
