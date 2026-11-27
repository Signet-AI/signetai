import { z } from "zod";

const reference = z
	.string()
	.regex(/^[A-Z][A-Z0-9_]{0,127}$/)
	.nullable();
const endpoint = z
	.url()
	.max(2048)
	.refine((value) => {
		if (!URL.canParse(value)) return false;
		const url = new URL(value);
		return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
	}, "Use an HTTP(S) endpoint without credentials, query, or fragment")
	.nullable();
const model = z.string().trim().max(200);
export const operatorInferenceSchema = z
	.object({
		provider: z.enum(["none", "openai-compatible", "openai", "anthropic", "google", "openrouter"]),
		model,
		endpoint,
		credentialRef: reference,
		allowRemote: z.boolean(),
	})
	.strict()
	.superRefine((value, context) => {
		if (value.provider === "none") return;
		if (!value.model) context.addIssue({ code: "custom", message: "Choose a model" });
		if (value.provider === "openai-compatible" && !value.endpoint)
			context.addIssue({ code: "custom", message: "Choose an endpoint" });
		const local =
			value.provider === "openai-compatible" &&
			value.endpoint &&
			URL.canParse(value.endpoint) &&
			["localhost", "127.0.0.1", "[::1]"].includes(new URL(value.endpoint).hostname);
		if (!local && !value.allowRemote)
			context.addIssue({ code: "custom", message: "Allow remote processing explicitly" });
		if (value.provider !== "openai-compatible" && !value.credentialRef)
			context.addIssue({ code: "custom", message: "Choose a Secrets reference" });
	});
export const operatorEmbeddingSchema = z
	.object({
		provider: z.enum(["none", "native", "ollama", "llama-cpp", "openai"]),
		model,
		dimensions: z.number().int().min(1).max(65536),
		endpoint,
		credentialRef: reference,
	})
	.strict()
	.superRefine((value, context) => {
		if (value.provider !== "none" && !value.model)
			context.addIssue({ code: "custom", message: "Choose an embedding model" });
		if (!["none", "native"].includes(value.provider) && !value.endpoint)
			context.addIssue({ code: "custom", message: "Choose an embedding endpoint" });
		if (value.provider === "openai" && !value.credentialRef)
			context.addIssue({ code: "custom", message: "Choose a Secrets reference" });
	});
export const operatorSourceDefaultsSchema = z
	.object({
		agentId: z.string().min(1).max(128),
		classificationId: z.string().min(1).max(200).nullable(),
	})
	.strict();
export const operatorSettingsInputSchema = z.discriminatedUnion("section", [
	z.object({ section: z.literal("inference"), value: operatorInferenceSchema }).strict(),
	z.object({ section: z.literal("embedding"), value: operatorEmbeddingSchema }).strict(),
	z.object({ section: z.literal("sourcesDefaults"), value: operatorSourceDefaultsSchema }).strict(),
	z.object({ section: z.literal("instructions"), value: z.string().max(65536) }).strict(),
	z.object({ section: z.literal("complete"), value: z.literal(true) }).strict(),
]);
export type OperatorSettingsInput = z.infer<typeof operatorSettingsInputSchema>;
export interface OperatorSettings {
	readonly inference: z.infer<typeof operatorInferenceSchema>;
	readonly embedding: z.infer<typeof operatorEmbeddingSchema>;
	readonly sourcesDefaults: z.infer<typeof operatorSourceDefaultsSchema>;
	readonly instructions: string;
	readonly complete: boolean;
}
