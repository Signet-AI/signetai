import { z } from "zod";
const text = z.string().trim().min(1).max(128);
export const oidcSchema = z
	.object({
		issuer: z.url().refine((value) => {
			const url = new URL(value);
			return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password && !url.search && !url.hash;
		}, "Issuer must be an HTTP(S) URL without credentials, query, or fragment"),
		clientId: text,
		clientSecretRef: text.optional(),
		scopes: z.array(text).max(20).optional(),
		groupClaim: text.optional(),
		groupMap: z.record(z.string(), text).optional(),
		allowedDomains: z.array(text).max(100).default([]),
	})
	.strict();
export const settingsSchema = z
	.object({
		name: text.optional(),
		agentModel: z.enum(["personal", "single"]).optional(),
		personalAgentsSelfService: z.boolean().optional(),
		passwordLogin: z.boolean().optional(),
		requireSso: z.boolean().optional(),
		sessionTtlSeconds: z.number().int().min(60).max(31_536_000).optional(),
		refreshTtlSeconds: z.number().int().min(60).max(31_536_000).optional(),
		accessTtlSeconds: z.number().int().min(60).max(86400).optional(),
		connectorKeyTtlSeconds: z.number().int().min(60).max(31_536_000).optional(),
		legacyKeyDeadline: z.iso.datetime().nullable().optional(),
		auditRetentionDays: z.number().int().min(1).max(3650).optional(),
		publicUrl: z
			.url()
			.refine((value) => ["http:", "https:"].includes(new URL(value).protocol))
			.optional(),
		oidc: oidcSchema.nullable().optional(),
	})
	.strict();
export const settingsColumns = {
	name: "name",
	agentModel: "agent_model",
	personalAgentsSelfService: "personal_agents_self_service",
	passwordLogin: "password_login",
	requireSso: "require_sso",
	sessionTtlSeconds: "session_ttl_seconds",
	refreshTtlSeconds: "refresh_ttl_seconds",
	accessTtlSeconds: "access_ttl_seconds",
	connectorKeyTtlSeconds: "connector_key_ttl_seconds",
	legacyKeyDeadline: "legacy_key_deadline",
	auditRetentionDays: "audit_retention_days",
	publicUrl: "public_url",
	oidc: "oidc_json",
};
