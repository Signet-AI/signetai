import {
	IDENTITY_MODES,
	IDENTITY_PRESETS,
	type IdentityContextFileEntry,
	type IdentityPresetName,
	type IdentitySpecialFileEntry,
	NETWORK_MODES,
} from "@signet/core";
import { z } from "zod";
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
const extractionProviderSchema = z.enum(EXTRACTION_PROVIDER_CHOICES);
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
		synthesisProvider: extractionProviderSchema.optional(),
		synthesisModel: z.string().optional(),
		synthesisEndpoint: httpEndpointSchema,
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
	})
	.superRefine((plan, ctx) => {
		// openai-compatible extraction has no implicit endpoint; the interactive
		// wizard defaults one, but a headless --file plan must state it.
		if (plan.extractionProvider === "openai-compatible" && !plan.extractionEndpoint) {
			ctx.addIssue({
				code: "custom",
				message: "openai-compatible extraction requires extractionEndpoint",
				path: ["extractionEndpoint"],
			});
		}
		if (plan.synthesisProvider === "openai-compatible" && !plan.synthesisEndpoint) {
			ctx.addIssue({
				code: "custom",
				message: "openai-compatible synthesis requires synthesisEndpoint",
				path: ["synthesisEndpoint"],
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
