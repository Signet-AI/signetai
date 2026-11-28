import { createRemoteJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import type { DbOwnerStatement } from "../db-owner-protocol";
import { getSecret } from "../secrets";
import { readInvite } from "./organization-operations";
import {
	auditStatement,
	digest,
	IdentityError,
	id,
	issueSession,
	matchesHash,
	organizationQuery,
	organizationWrite,
	personalAgentStatements,
	readOrganization,
	readUser,
	secret,
	statement,
	type UserRow,
} from "./organization-store";

const configSchema = z.object({
	issuer: z.url(),
	clientId: z.string().min(1),
	clientSecretRef: z.string().optional(),
	scopes: z.array(z.string()).optional(),
	groupClaim: z.string().optional(),
	groupMap: z.record(z.string(), z.string()).optional(),
	allowedDomains: z.array(z.string()).default([]),
});
const discoverySchema = z.object({
	issuer: z.url(),
	authorization_endpoint: z.url(),
	token_endpoint: z.url(),
	jwks_uri: z.url(),
});
interface OidcState {
	nonceHash: string;
	verifier: string;
	redirectUri: string;
	issuer: string;
	clientId: string;
	invite: string | null;
	expiresAt: number;
}
const states = new Map<string, OidcState>();
function permittedUrl(raw: string): URL {
	const url = new URL(raw);
	if (
		url.protocol !== "https:" &&
		!(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname))
	)
		throw new IdentityError(403, "org_policy", "OIDC endpoints require HTTPS");
	return url;
}
async function configuration() {
	const org = await readOrganization();
	if (!org.claimed_at || !org.oidc_json) throw new IdentityError(403, "org_policy", "SSO is not configured");
	const config = configSchema.parse(JSON.parse(org.oidc_json));
	permittedUrl(config.issuer);
	return { org, config };
}
async function fetchJson(url: string, init?: RequestInit): Promise<unknown> {
	const response = await fetch(permittedUrl(url), { ...init, redirect: "error", signal: AbortSignal.timeout(5000) });
	if (!response.ok) throw new IdentityError(401, "invalid_credential", "OIDC provider rejected the request");
	if (Number(response.headers.get("content-length")) > 1_048_576) throw new IdentityError(401, "invalid_credential");
	const reader = response.body?.getReader();
	if (!reader) throw new IdentityError(401, "invalid_credential");
	const chunks: Uint8Array[] = [];
	let bytes = 0;
	try {
		for (;;) {
			const item = await reader.read();
			if (item.done) break;
			bytes += item.value.byteLength;
			if (bytes > 1_048_576) throw new IdentityError(401, "invalid_credential");
			chunks.push(item.value);
		}
	} finally {
		await reader.cancel();
	}
	return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}
async function fetchDiscovery(issuer: string) {
	const result = discoverySchema.parse(
		await fetchJson(`${issuer.replace(/\/$/, "")}/.well-known/openid-configuration`),
	);
	if (result.issuer !== issuer) throw new IdentityError(401, "invalid_credential", "OIDC discovery issuer mismatch");
	for (const url of [result.authorization_endpoint, result.token_endpoint, result.jwks_uri]) permittedUrl(url);
	return result;
}
const discoveryCache = new Map<string, { expiresAt: number; value: Promise<z.infer<typeof discoverySchema>> }>();
async function discover(issuer: string) {
	const now = Date.now();
	for (const [key, entry] of discoveryCache) if (entry.expiresAt <= now) discoveryCache.delete(key);
	const cached = discoveryCache.get(issuer);
	if (cached) return cached.value;
	if (discoveryCache.size >= 32) {
		const oldest = discoveryCache.keys().next().value;
		if (oldest !== undefined) discoveryCache.delete(oldest);
	}
	const value = fetchDiscovery(issuer);
	discoveryCache.set(issuer, { expiresAt: now + 300_000, value });
	try {
		return await value;
	} catch (error) {
		if (discoveryCache.get(issuer)?.value === value) discoveryCache.delete(issuer);
		throw error;
	}
}
export async function oidcStart(origin: string, invite?: string) {
	const { org, config } = await configuration();
	if (invite) await readInvite(invite);
	const now = Date.now();
	for (const [key, value] of states) if (value.expiresAt <= now) states.delete(key);
	if (states.size >= 1024) throw new IdentityError(429, "rate_limit");
	const discovery = await discover(config.issuer);
	const state = secret(),
		nonce = secret(),
		verifier = secret();
	const redirectUri = `${org.public_url ?? origin}/api/auth/sso/callback`;
	states.set(digest(state), {
		nonceHash: digest(nonce),
		verifier,
		redirectUri,
		issuer: config.issuer,
		clientId: config.clientId,
		invite: invite ?? null,
		expiresAt: now + 600_000,
	});
	const url = new URL(discovery.authorization_endpoint);
	url.search = new URLSearchParams({
		response_type: "code",
		client_id: config.clientId,
		redirect_uri: redirectUri,
		scope: [...new Set(["openid", "email", "profile", ...(config.scopes ?? [])])].join(" "),
		state,
		nonce,
		code_challenge: Buffer.from(digest(verifier), "hex").toString("base64url"),
		code_challenge_method: "S256",
	}).toString();
	return { url: url.toString(), state };
}
export async function oidcCallback(
	input: { state: string; code: string; cookieState: string | undefined },
	origin: string,
) {
	const entry = states.get(digest(input.state));
	states.delete(digest(input.state));
	if (
		!entry ||
		entry.expiresAt <= Date.now() ||
		!input.cookieState ||
		!matchesHash(input.cookieState, digest(input.state))
	)
		throw new IdentityError(401, "invalid_credential", "Invalid SSO state");
	const { org, config } = await configuration();
	if (
		entry.issuer !== config.issuer ||
		entry.clientId !== config.clientId ||
		entry.redirectUri !== `${org.public_url ?? origin}/api/auth/sso/callback`
	)
		throw new IdentityError(401, "invalid_credential");
	const discovery = await discover(config.issuer);
	const form = new URLSearchParams({
		grant_type: "authorization_code",
		code: input.code,
		client_id: config.clientId,
		redirect_uri: entry.redirectUri,
		code_verifier: entry.verifier,
	});
	if (config.clientSecretRef) form.set("client_secret", await getSecret(config.clientSecretRef));
	const token = z.object({ id_token: z.string().min(1).max(65536) }).parse(
		await fetchJson(discovery.token_endpoint, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded" },
			body: form.toString(),
		}),
	);
	let claims: Awaited<ReturnType<typeof jwtVerify>>["payload"];
	try {
		claims = (
			await jwtVerify(
				token.id_token,
				createRemoteJWKSet(new URL(discovery.jwks_uri), { timeoutDuration: 5000, cooldownDuration: 30_000 }),
				{
					issuer: config.issuer,
					audience: config.clientId,
					algorithms: ["RS256", "PS256", "ES256", "EdDSA"],
					requiredClaims: ["sub", "iss", "aud", "exp", "iat", "nonce"],
				},
			)
		).payload;
	} catch {
		throw new IdentityError(401, "invalid_credential", "Invalid OIDC identity token");
	}
	if (typeof claims.nonce !== "string" || !matchesHash(claims.nonce, entry.nonceHash) || !claims.sub)
		throw new IdentityError(401, "invalid_credential", "OIDC nonce mismatch");
	if (Array.isArray(claims.aud) && claims.aud.length > 1 && claims.azp !== config.clientId)
		throw new IdentityError(401, "invalid_credential");
	const email = z.email().parse(claims.email).toLowerCase();
	const domain = email.split("@")[1];
	if (!domain || !config.allowedDomains.some((d) => d.toLowerCase() === domain) || claims.email_verified !== true)
		throw new IdentityError(403, "org_policy", "Your verified email domain is not allowed");
	const invite = entry.invite ? await readInvite(entry.invite) : null;
	if (invite?.email && invite.email.toLowerCase() !== email)
		throw new IdentityError(403, "org_policy", "Invitation email does not match");
	let user = await organizationQuery<UserRow | null>(
		statement("SELECT * FROM users WHERE oidc_issuer = ? AND oidc_subject = ?", [config.issuer, claims.sub], "get"),
	);
	const now = new Date().toISOString();
	const writes: DbOwnerStatement[] = [];
	const userId = user?.id ?? id("usr");
	if (!user) {
		const existing = await organizationQuery(statement("SELECT id FROM users WHERE email = ?", [email], "get"));
		if (existing)
			throw new IdentityError(
				403,
				"org_policy",
				"An account with this email already exists; ask an administrator to link it",
			);
		const name = typeof claims.name === "string" ? claims.name.slice(0, 128) : email;
		const username = `${email
			.split("@")[0]
			?.replace(/[^a-zA-Z0-9._-]/g, "-")
			.slice(0, 80)}-${userId.slice(-8)}`;
		writes.push(
			statement(
				"INSERT INTO users (id,username,email,display_name,role,oidc_issuer,oidc_subject,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?)",
				[userId, username, email, name, invite?.role ?? "member", config.issuer, claims.sub, now, now],
			),
		);
		if (org.agent_model === "personal")
			writes.push(...personalAgentStatements(userId, `personal-${userId.slice(4)}`, name));
	} else if (user.status !== "active") throw new IdentityError(401, "user_deactivated");
	if (invite) {
		writes.push({
			...statement("UPDATE user_invites SET used_at = ?,used_by = ? WHERE id = ? AND used_at IS NULL", [
				now,
				userId,
				invite.id,
			]),
			requireChanges: true,
		});
		for (const groupId of z.array(z.string()).parse(JSON.parse(invite.group_ids_json)))
			writes.push(
				statement("INSERT OR IGNORE INTO group_members (group_id,user_id,role,created_at) VALUES (?,?,'member',?)", [
					groupId,
					userId,
					now,
				]),
			);
	}
	const claimGroups = config.groupClaim
		? z
				.array(z.string())
				.max(1000)
				.parse(claims[config.groupClaim] ?? [])
		: [];
	writes.push(statement("DELETE FROM group_members WHERE user_id = ? AND managed_by = 'idp'", [userId]));
	for (const [providerGroup, groupId] of Object.entries(config.groupMap ?? {})) {
		if (!claimGroups.includes(providerGroup)) continue;
		writes.push(
			statement(
				"INSERT INTO groups (id,name,managed_by,idp_group,created_at,updated_at) VALUES (?,?,'idp',?,?,?) ON CONFLICT(id) DO UPDATE SET managed_by = 'idp',idp_group = excluded.idp_group,updated_at = excluded.updated_at",
				[groupId, providerGroup, providerGroup, now, now],
			),
		);
		writes.push(
			statement(
				"INSERT INTO group_members (group_id,user_id,role,managed_by,created_at) VALUES (?,?,'member','idp',?) ON CONFLICT(group_id,user_id) DO NOTHING",
				[groupId, userId, now],
			),
		);
	}
	writes.push(
		statement("UPDATE users SET last_active_at = ? WHERE id = ?", [now, userId]),
		auditStatement(null, "user.sso_login", "user", userId),
	);
	await organizationWrite(writes);
	user = await readUser(userId);
	if (!user) throw new Error("SSO user did not persist");
	return issueSession(user.id, "browser");
}
