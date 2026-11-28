import { attemptAsync, inFlightClassificationSql } from "@signet/core";
import { logger } from "../logger";
import { recordAuthObservation } from "./observations";
import { publishSetupToken, removeSetupToken } from "./setup-token-file";
import { createHash, pbkdf2, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { DbOwnerStatement } from "../db-owner-protocol";
import { prepareTypedStatement, type ReadDb } from "../db-accessor";
import { dbOwnerQuery, dbOwnerTransaction, ownerStatement } from "../db-owner-runtime";
import { type AgentRecord, bindPrincipalAccess, principalAccess } from "./agent-access";
import type { Principal } from "./principal";
import { rolePermissions } from "./principal";
import { appendRefreshRetry, replayRefreshRetry } from "./refresh-retry";
import { PERMISSIONS, type Permission, type TokenRole } from "./types";

export function organizationClaimedInDb(db: ReadDb): boolean {
	return (
		prepareTypedStatement<{ claimed_at: string | null }>(db, "SELECT claimed_at FROM organization WHERE id=1").get()
			?.claimed_at != null
	);
}

export function structuralPersonIdentityInDb(db: ReadDb, agentId: string, userId: string) {
	return prepareTypedStatement<{
		id: string;
		display_name: string;
		person_id: string | null;
		person_name: string | null;
	}>(
		db,
		`SELECT u.id,u.display_name,p.id AS person_id,p.name AS person_name FROM users u
   LEFT JOIN entities p ON p.person_user_id=u.id AND p.agent_id=? AND p.compartment_id IS NULL
   WHERE u.id=?`,
	).get(agentId, userId);
}

export const statement = ownerStatement;
export function organizationQuery<T>(s: DbOwnerStatement): Promise<T> {
	return dbOwnerQuery<T>(s, { operation: "organization.read", lane: "read" });
}
export async function organizationWrite(
	statements: readonly DbOwnerStatement[],
	conflict?: 401 | 409 | 429,
): Promise<readonly unknown[]> {
	try {
		return await dbOwnerTransaction(statements, { operation: "organization.write", lane: "write", deadlineMs: 30_000 });
	} catch (error) {
		if (conflict && error instanceof Error && error.message === "DB owner transaction precondition changed zero rows")
			throw new IdentityError(
				conflict,
				conflict === 401 ? "invalid_credential" : conflict === 429 ? "rate_limit" : "org_policy",
			);
		throw error;
	}
}
export function id(prefix: string): string {
	return `${prefix}_${crypto.randomUUID().replaceAll("-", "")}`;
}
export function secret(): string {
	return randomBytes(32).toString("base64url");
}
export function digest(value: string): string {
	return createHash("sha256").update(value).digest("hex");
}
export function matchesHash(value: string, hash: string | null): boolean {
	if (!hash || !/^[a-f0-9]{64}$/.test(hash)) return false;
	return timingSafeEqual(Buffer.from(digest(value), "hex"), Buffer.from(hash, "hex"));
}
export class IdentityError extends Error {
	constructor(
		readonly status: 400 | 401 | 403 | 404 | 409 | 410 | 413 | 428 | 429 | 503,
		readonly reason: string,
		message = reason.replaceAll("_", " "),
	) {
		super(message);
	}
}
export interface OrganizationRow {
	id: number;
	name: string | null;
	claimed_at: string | null;
	claimed_by: string | null;
	setup_token_hash: string | null;
	agent_model: "personal" | "single";
	personal_agents_self_service: number;
	password_login: number;
	require_sso: number;
	session_ttl_seconds: number;
	refresh_ttl_seconds: number;
	access_ttl_seconds: number;
	connector_key_ttl_seconds: number;
	legacy_key_deadline: string | null;
	oidc_json: string | null;
	audit_retention_days: number;
	public_url: string | null;
}
export interface UserRow {
	id: string;
	username: string;
	email: string | null;
	display_name: string;
	role: TokenRole;
	compliance: number;
	status: "active" | "deactivated";
	password_hash: string | null;
	oidc_issuer?: string | null;
	personal_agent_id: string | null;
	default_read_agent_id: string | null;
}
export interface SessionRow {
	id: string;
	user_id: string;
	kind: "browser" | "cli" | "desktop";
	device_id: string | null;
	token_hash: string;
	access_expires_at: string;
	refresh_hash: string | null;
	refresh_retry_json: string;
	refresh_expires_at: string | null;
	source_key_id: string | null;
	source_key_ceiling_json: string | null;
	permission_ceiling_json: string | null;
	csrf_hash: string | null;
	created_at: string;
	last_used_at: string | null;
	revoked_at: string | null;
	revoked_reason: string | null;
}
export function readOrganization(): Promise<OrganizationRow> {
	return organizationQuery(statement("SELECT * FROM organization WHERE id = 1", [], "get"));
}
export function readUser(userId: string): Promise<UserRow | null> {
	return organizationQuery(statement("SELECT * FROM users WHERE id = ?", [userId], "get"));
}
export function userView(u: UserRow) {
	return {
		id: u.id,
		username: u.username,
		email: u.email,
		displayName: u.display_name,
		role: u.role,
		compliance: Boolean(u.compliance),
		ssoManaged: Boolean(u.oidc_issuer),
	};
}
export function auditStatement(
	p: Principal | null,
	action: string,
	targetKind: string | null = null,
	targetId: string | null = null,
	detail: unknown = null,
	outcome: "ok" | "denied" | "failed" = "ok",
): DbOwnerStatement {
	return statement(
		"INSERT OR IGNORE INTO audit_events (id,at,actor_user_id,actor_credential,action,target_kind,target_id,outcome,detail_json) VALUES (?,?,?,?,?,?,?,?,?)",
		[
			id("aud"),
			new Date().toISOString(),
			p?.userId ?? null,
			p ? `${p.credential.kind}:${p.credential.id}` : "system",
			action,
			targetKind,
			targetId,
			outcome,
			JSON.stringify(detail),
		],
	);
}
export async function ensureSetupToken(agentsDir?: string): Promise<string | null> {
	const token = secret();
	const results = await organizationWrite([
		statement(
			"UPDATE organization SET setup_token_hash = ? WHERE id = 1 AND claimed_at IS NULL RETURNING id",
			[digest(token)],
			"get",
		),
	]);
	if (results[0] && agentsDir) await publishSetupToken(agentsDir, token);
	return results[0] ? token : null;
}
function passwordDigest(password: string, salt: Buffer, iterations: number): Promise<Buffer> {
	return new Promise((resolve, reject) =>
		pbkdf2(password, salt, iterations, 32, "sha256", (error, key) => (error ? reject(error) : resolve(key))),
	);
}
export async function passwordHash(password: string): Promise<string> {
	const salt = randomBytes(16);
	const key = await passwordDigest(password, salt, 600_000);
	return `pbkdf2-sha256$600000$${salt.toString("base64url")}$${key.toString("base64url")}`;
}
export async function verifyUserPassword(password: string, hash: string | null): Promise<boolean> {
	if (!hash) {
		await passwordDigest(password, Buffer.alloc(16), 600_000);
		return false;
	}
	const [algorithm, count, saltText, keyText] = hash.split("$");
	const iterations = Number(count);
	if (
		algorithm !== "pbkdf2-sha256" ||
		!saltText ||
		!keyText ||
		!Number.isInteger(iterations) ||
		iterations < 10_000 ||
		iterations > 1_000_000
	)
		return false;
	const key = Buffer.from(keyText, "base64url");
	const salt = Buffer.from(saltText, "base64url");
	if (key.length !== 32 || salt.length < 8) return false;
	return timingSafeEqual(key, await passwordDigest(password, salt, iterations));
}
export function personalAgentStatements(userId: string, agentId: string, name: string): readonly DbOwnerStatement[] {
	const now = new Date().toISOString();
	return [
		statement(
			"INSERT INTO agents (id,name,read_policy,kind,owner_user_id,created_at,updated_at) VALUES (?,?,'isolated','personal',?,?,?)",
			[agentId, name, userId, now, now],
		),
		statement("UPDATE users SET personal_agent_id = ? WHERE id = ?", [agentId, userId]),
	];
}
export function visibleAgentSql(p: Pick<Principal, "kind" | "userId" | "boundAgentId">) {
	if (p.kind === "local") return { sql: "1=1", args: [] };
	return {
		sql: `(? IS NULL OR a.id=?) AND NOT EXISTS(SELECT 1 FROM classification_assignments ca WHERE ca.target_kind='agent' AND ca.target_id=a.id AND NOT EXISTS(SELECT 1 FROM classification_audience audience WHERE audience.classification_id=ca.classification_id AND ((audience.principal_kind='user' AND audience.principal_id=?) OR (audience.principal_kind='group' AND audience.principal_id IN (SELECT group_id FROM group_members WHERE user_id=?))))) AND NOT EXISTS(SELECT 1 FROM org_jobs j WHERE ${inFlightClassificationSql("j")} AND json_extract(j.params_json,'$.target.kind')='agent' AND json_extract(j.params_json,'$.target.agentId')=a.id)`,
		args: [p.boundAgentId, p.boundAgentId, p.userId, p.userId, p.userId, p.userId],
	};
}
export async function requireVisibleAgent(p: Principal, agentId: string) {
	const visible = visibleAgentSql(p);
	const agent = await organizationQuery<(AgentRecord & { name: string }) | null>(
		statement(`SELECT a.* FROM agents a WHERE a.id=? AND ${visible.sql}`, [agentId, ...visible.args], "get"),
	);
	if (!agent) throw new IdentityError(404, "not_found");
	return agent;
}
export async function bindAccess(p: Principal, u: UserRow | null, org: OrganizationRow): Promise<void> {
	if (u && !u.personal_agent_id && org.agent_model === "personal" && org.personal_agents_self_service) {
		const agentId = `personal-${u.id.slice(4)}`;
		const now = new Date().toISOString();
		await organizationWrite([
			statement(
				"INSERT OR IGNORE INTO agents (id,name,kind,owner_user_id,read_policy,created_at,updated_at) VALUES (?,?,'personal',?,'isolated',?,?)",
				[agentId, u.display_name, u.id, now, now],
			),
			statement("UPDATE users SET personal_agent_id = ? WHERE id = ? AND personal_agent_id IS NULL", [agentId, u.id]),
			auditStatement(p, "agent.personal_created", "agent", agentId),
		]);
		u = await readUser(u.id);
	}
	const visible = visibleAgentSql(p);
	const agents = await organizationQuery<AgentRecord[]>(
		statement(
			`SELECT id,kind,owner_user_id,owner_group_id,archived_at FROM agents a WHERE archived_at IS NULL AND (kind = 'organization' OR (kind = 'personal' AND owner_user_id = ?) OR (kind = 'team' AND owner_group_id IN (SELECT group_id FROM group_members WHERE user_id = ?)) OR id = ? OR id = ? OR (? = 'admin' AND kind = 'legacy')) AND ${visible.sql}`,
			[p.userId, p.userId, p.boundAgentId, u?.default_read_agent_id ?? null, p.role, ...visible.args],
			"all",
		),
	);
	bindPrincipalAccess(p, {
		agentModel: org.agent_model,
		personalAgentsSelfService: Boolean(org.personal_agents_self_service),
		organizationAgentId: "default",
		personalAgentId: u?.personal_agent_id ?? null,
		defaultReadAgentId: u?.default_read_agent_id ?? null,
		agents,
	});
}
export async function bindRequestedReadAgent(p: Principal, id: string | undefined): Promise<void> {
	const access = principalAccess(p);
	if (!id || !access || access.agents.some((a) => a.id === id)) return;
	const agent = await requireVisibleAgent(p, id);
	bindPrincipalAccess(p, { ...access, agents: [...access.agents, agent] });
}
export async function activeUser(userId: string, deviceId: string | null): Promise<UserRow> {
	const u = await readUser(userId);
	if (!u) throw new IdentityError(401, "invalid_credential");
	if (u.status !== "active") throw new IdentityError(401, "user_deactivated");
	if (deviceId) {
		const device = await organizationQuery<{ revoked_at: string | null; user_id: string } | null>(
			statement("SELECT user_id,revoked_at FROM devices WHERE id = ?", [deviceId], "get"),
		);
		if (!device || device.user_id !== userId || device.revoked_at) throw new IdentityError(401, "device_revoked");
	}
	return u;
}
export async function userPrincipal(
	user: UserRow,
	credential: Principal["credential"],
	sessionId: string | null,
	deviceId: string | null,
	harness: string | null = null,
	boundAgentId: string | null = null,
	allowedProjects: readonly string[] | null = null,
	permissionLimit?: readonly Permission[],
): Promise<Principal> {
	const groups = await organizationQuery<{ group_id: string }[]>(
		statement("SELECT group_id FROM group_members WHERE user_id = ?", [user.id], "all"),
	);
	const granted = rolePermissions(user.role, Boolean(user.compliance));
	return {
		kind: "user",
		userId: user.id,
		role: user.role,
		permissions: new Set([...granted].filter((p) => !permissionLimit || permissionLimit.includes(p))),
		compliance: Boolean(user.compliance),
		groupIds: groups.map((g) => g.group_id),
		credential,
		sessionId,
		deviceId,
		harness,
		boundAgentId,
		allowedProjects,
	};
}
const keySessionCeilingSchema = z
	.object({
		permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length),
		agentId: z.string().min(1).max(200).nullable(),
		projects: z.array(z.string().min(1).max(4096)).max(100).nullable(),
		expiresAt: z.iso.datetime().optional(),
	})
	.strict();
export interface SessionKeyBinding {
	readonly sourceKeyId: string | null;
	readonly ceiling: z.infer<typeof keySessionCeilingSchema>;
}
function storedJson(value: string): unknown {
	try {
		return JSON.parse(value);
	} catch {
		throw new IdentityError(401, "invalid_credential");
	}
}
export function sourceSessionBinding(session: SessionRow): SessionKeyBinding | undefined {
	const raw = session.source_key_id ? session.source_key_ceiling_json : session.permission_ceiling_json;
	if (!session.source_key_id && !raw && !session.source_key_ceiling_json) return undefined;
	if (!raw || (!session.source_key_id && session.source_key_ceiling_json))
		throw new IdentityError(401, "invalid_credential");
	const ceiling = keySessionCeilingSchema.safeParse(storedJson(raw));
	if (!ceiling.success) throw new IdentityError(401, "invalid_credential");
	return { sourceKeyId: session.source_key_id, ceiling: ceiling.data };
}
function intersectProjects(left: readonly string[] | null, right: readonly string[] | null): readonly string[] | null {
	if (left === null) return right;
	return right === null ? left : left.filter((project) => right.includes(project));
}
async function sessionKeyLimits(session: SessionRow) {
	const binding = sourceSessionBinding(session);
	if (!binding) return undefined;
	if (!binding.sourceKeyId) return { ...binding.ceiling, expiresAt: undefined, sourceKeyId: undefined };
	if (!binding.ceiling.expiresAt) throw new IdentityError(401, "invalid_credential");
	const key = await readBoundKey(binding.sourceKeyId);
	if (!key || key.user_id !== session.user_id || key.kind !== "personal")
		throw new IdentityError(401, "invalid_credential");
	if (key.revoked_at) throw new IdentityError(401, "revoked");
	await activeUser(session.user_id, key.device_id);
	const expiresAt =
		key.expires_at && key.expires_at < binding.ceiling.expiresAt ? key.expires_at : binding.ceiling.expiresAt;
	if (expiresAt <= new Date().toISOString()) throw new IdentityError(401, "expired");
	const scope = z
		.object({ user: z.string().optional(), agent: z.string().optional(), project: z.string().optional() })
		.passthrough()
		.safeParse(storedJson(key.scope_json));
	const permissions = z.array(z.enum(PERMISSIONS)).safeParse(storedJson(key.permissions_json));
	const projects = key.allowed_projects_json
		? z.array(z.string()).safeParse(storedJson(key.allowed_projects_json))
		: { success: true as const, data: null };
	if (
		!scope.success ||
		!permissions.success ||
		!projects.success ||
		(scope.data.user && scope.data.user !== session.user_id)
	)
		throw new IdentityError(401, "invalid_credential");
	if (key.agent_id && scope.data.agent && key.agent_id !== scope.data.agent)
		throw new IdentityError(401, "invalid_credential");
	const liveAgent = key.agent_id ?? scope.data.agent ?? null;
	if (binding.ceiling.agentId && liveAgent && binding.ceiling.agentId !== liveAgent)
		throw new IdentityError(401, "agent_binding_conflict");
	return {
		sourceKeyId: key.id,
		permissions: binding.ceiling.permissions.filter((permission) => permissions.data.includes(permission)),
		agentId: binding.ceiling.agentId ?? liveAgent,
		projects: intersectProjects(
			binding.ceiling.projects,
			intersectProjects(projects.data, scope.data.project ? [scope.data.project] : null),
		),
		expiresAt,
	};
}

export function sessionMaterial(
	userId: string,
	kind: SessionRow["kind"],
	deviceId: string | null,
	org: OrganizationRow,
	binding?: SessionKeyBinding,
	admission?: "key-exchange",
) {
	if (binding?.sourceKeyId && kind !== "browser") throw new IdentityError(403, "org_policy");
	const sessionId = id("ses");
	const access = secret();
	const refresh = kind === "browser" ? null : secret();
	const csrf = kind === "browser" ? secret() : null;
	const now = new Date().toISOString();
	const expires = new Date(
		Date.now() + (kind === "browser" ? org.session_ttl_seconds : org.access_ttl_seconds) * 1000,
	).toISOString();
	const ceilingExpiry = binding?.sourceKeyId ? binding.ceiling.expiresAt : undefined;
	const accessExpiresAt = ceilingExpiry && ceilingExpiry < expires ? ceilingExpiry : expires;
	const refreshExpiry = new Date(Date.now() + org.refresh_ttl_seconds * 1000).toISOString();
	const refreshExpiresAt = refresh
		? ceilingExpiry && ceilingExpiry < refreshExpiry
			? ceilingExpiry
			: refreshExpiry
		: null;
	return {
		sessionId,
		accessToken: `sig_ses_${sessionId}_${access}`,
		refreshToken: refresh ? `sig_ref_${sessionId}_${refresh}` : null,
		csrf,
		accessExpiresAt,
		refreshExpiresAt,
		deviceId,
		statements: [
			{
				...statement(
					"INSERT INTO auth_sessions (id,user_id,kind,device_id,token_hash,access_expires_at,refresh_hash,refresh_expires_at,csrf_hash,created_at,last_used_at,source_key_id,source_key_ceiling_json,permission_ceiling_json) SELECT ?,?,?,?,?,?,?,?,?,?,?,?,?,? WHERE ?=0 OR ((SELECT count(*) FROM (SELECT 1 FROM auth_sessions WHERE user_id=? AND source_key_id IS NOT NULL AND revoked_at IS NULL AND access_expires_at>? LIMIT 20))<20 AND (SELECT count(*) FROM (SELECT 1 FROM auth_sessions WHERE source_key_id IS NOT NULL AND revoked_at IS NULL AND access_expires_at>? LIMIT 1000))<1000)",
					[
						sessionId,
						userId,
						kind,
						deviceId,
						digest(access),
						accessExpiresAt,
						refresh ? digest(refresh) : null,
						refreshExpiresAt,
						csrf ? digest(csrf) : null,
						now,
						now,
						binding?.sourceKeyId ?? null,
						binding?.sourceKeyId ? JSON.stringify(binding.ceiling) : null,
						binding && !binding.sourceKeyId ? JSON.stringify(binding.ceiling) : null,
						Number(admission === "key-exchange"),
						userId,
						now,
						now,
					],
				),
				requireChanges: true,
			},
		],
	};
}
export async function issueSession(userId: string, kind: SessionRow["kind"], deviceId: string | null = null) {
	const user = await activeUser(userId, deviceId);
	const org = await readOrganization();
	const material = sessionMaterial(userId, kind, deviceId, org);
	await organizationWrite([
		...material.statements,
		auditStatement(
			await userPrincipal(user, { kind: "session", id: material.sessionId }, material.sessionId, deviceId),
			"session.created",
			"session",
			material.sessionId,
			{ userId },
		),
	]);
	const { statements: _statements, ...result } = material;
	return { ...result, user: userView(user) };
}
export async function prepareOrganizationBootstrap(raw: unknown) {
	const data = z
		.object({ setupToken: z.string().min(20).max(256), publicUrl: z.url() })
		.strict()
		.parse(raw);
	const url = new URL(data.publicUrl);
	if (
		url.username ||
		url.password ||
		url.search ||
		url.hash ||
		url.pathname !== "/" ||
		(url.protocol !== "https:" &&
			!(url.protocol === "http:" && ["127.0.0.1", "localhost", "[::1]"].includes(url.hostname)))
	)
		throw new IdentityError(400, "invalid_public_url");
	const org = await readOrganization();
	if (org.claimed_at) throw new IdentityError(409, "org_policy");
	if (!matchesHash(data.setupToken, org.setup_token_hash)) throw new IdentityError(401, "invalid_credential");
	await organizationWrite([
		{
			...statement(
				"UPDATE organization SET public_url=?,updated_at=? WHERE id=1 AND claimed_at IS NULL AND setup_token_hash=?",
				[url.origin, new Date().toISOString(), org.setup_token_hash],
			),
			requireChanges: true,
		},
		auditStatement(null, "organization.bootstrap", "instance", null),
	]);
	return { prepared: true, publicUrl: url.origin };
}
export const claimSchema = z.object({
	setupToken: z.string().min(20).max(256),
	organizationName: z.string().trim().min(1).max(128),
	admin: z.object({
		username: z.string().trim().min(1).max(128),
		displayName: z.string().min(1).max(128),
		email: z.email().optional(),
		password: z.string().min(1).max(1024),
	}),
});
export async function claimOrganization(input: z.infer<typeof claimSchema>, agentsDir?: string) {
	const org = await readOrganization();
	if (org.claimed_at) throw new IdentityError(409, "org_policy");
	if (!matchesHash(input.setupToken, org.setup_token_hash)) throw new IdentityError(401, "invalid_credential");
	const userId = id("usr");
	const agentId = `personal-${userId.slice(4)}`;
	const now = new Date().toISOString();
	const material = sessionMaterial(userId, "browser", null, org);
	await organizationWrite(
		[
			{
				...statement(
					"UPDATE organization SET name = ?,claimed_at = ?,claimed_by = ?,setup_token_hash = NULL,legacy_key_deadline = ?,updated_at = ? WHERE id = 1 AND claimed_at IS NULL AND setup_token_hash = ?",
					[
						input.organizationName,
						now,
						userId,
						new Date(Date.now() + 14 * 86400_000).toISOString(),
						now,
						org.setup_token_hash,
					],
				),
				requireChanges: true,
			},
			statement(
				"INSERT INTO users (id,username,email,display_name,role,password_hash,created_at,updated_at) VALUES (?,?,?,?,'admin',?,?,?)",
				[
					userId,
					input.admin.username,
					input.admin.email ?? null,
					input.admin.displayName,
					await passwordHash(input.admin.password),
					now,
					now,
				],
			),
			statement("UPDATE agents SET kind = 'organization' WHERE id = 'default'"),
			...personalAgentStatements(userId, agentId, input.admin.displayName),
			...material.statements,
			auditStatement(null, "organization.claimed", "organization", "1", { userId }),
		],
		409,
	);
	const user = await readUser(userId);
	if (!user) throw new Error("Claim did not persist its user");
	if (
		agentsDir &&
		!(await attemptAsync(async () => {
			await removeSetupToken(agentsDir);
			return true;
		}))
	)
		logger.warn("auth", "Claim completed, but the revoked setup-token file could not be removed");
	const { statements: _statements, ...result } = material;
	return { ...result, user: userView(user) };
}
export function parseSessionToken(token: string, prefix: "ses" | "ref"): { sessionId: string; secret: string } | null {
	const match = new RegExp(`^sig_${prefix}_(ses_[a-f0-9]{32})_([A-Za-z0-9_-]{43})$`).exec(token);
	return match?.[1] && match[2] ? { sessionId: match[1], secret: match[2] } : null;
}
export async function issueKeyBrowserSession(p: Principal) {
	if (p.kind !== "user" || !p.userId || p.credential.kind !== "api_key")
		throw new IdentityError(403, "org_policy", "Requires a personal API key");
	const key = await readBoundKey(p.credential.id);
	if (!key || key.user_id !== p.userId || key.kind !== "personal" || key.legacy)
		throw new IdentityError(403, "org_policy", "Only personal API keys can be exchanged");
	if (key.revoked_at) throw new IdentityError(401, "revoked");
	if (key.expires_at && key.expires_at <= new Date().toISOString()) throw new IdentityError(401, "expired");
	const user = await activeUser(p.userId, key.device_id);
	const org = await readOrganization();
	const binding: SessionKeyBinding = {
		sourceKeyId: key.id,
		ceiling: {
			permissions: [...p.permissions],
			agentId: p.boundAgentId,
			projects: p.allowedProjects ? [...p.allowedProjects] : null,
			expiresAt: key.expires_at ?? new Date(Date.now() + org.session_ttl_seconds * 1000).toISOString(),
		},
	};
	const material = sessionMaterial(user.id, "browser", key.device_id, org, binding, "key-exchange");
	await organizationWrite(
		[
			...material.statements,
			auditStatement(p, "session.key_exchanged", "session", material.sessionId, { sourceKeyId: key.id }),
		],
		429,
	);
	const { statements: _statements, ...result } = material;
	return { ...result, user: userView(user) };
}
export async function resolveSessionPrincipal(session: SessionRow, org: OrganizationRow) {
	if (session.revoked_at) throw new IdentityError(401, "revoked");
	if (session.access_expires_at <= new Date().toISOString()) throw new IdentityError(401, "expired");
	const user = await activeUser(session.user_id, session.device_id);
	const limits = await sessionKeyLimits(session);
	const base = await userPrincipal(
		user,
		{ kind: "session", id: session.id },
		session.id,
		session.device_id,
		null,
		limits?.agentId ?? null,
		limits?.projects ?? null,
		limits?.permissions,
	);
	const principal = limits ? { ...base, sourceKeyId: limits.sourceKeyId } : base;
	await bindAccess(principal, user, org);
	return { user, principal, expiresAtCeiling: limits?.expiresAt };
}
export async function verifySession(
	token: string,
	csrf: string | undefined,
	requireCsrf: boolean,
	org: OrganizationRow,
) {
	const parsed = parseSessionToken(token, "ses");
	if (!parsed) throw new IdentityError(401, "invalid_credential");
	const session = await organizationQuery<SessionRow | null>(
		statement("SELECT * FROM auth_sessions WHERE id = ?", [parsed.sessionId], "get"),
	);
	if (!session || !matchesHash(parsed.secret, session.token_hash)) throw new IdentityError(401, "invalid_credential");
	const { user, principal, expiresAtCeiling } = await resolveSessionPrincipal(session, org);
	if (requireCsrf && (!csrf || !matchesHash(csrf, session.csrf_hash))) throw new IdentityError(403, "csrf");
	if (session.refresh_retry_json !== "[]")
		await organizationWrite([
			statement(
				"UPDATE auth_sessions SET refresh_retry_json = '[]' WHERE id = ? AND token_hash = ? AND revoked_at IS NULL",
				[session.id, session.token_hash],
			),
		]);
	const now = Date.now();
	let currentSession = session;
	if (
		!session.last_used_at ||
		Date.parse(session.last_used_at) <= now - 60_000 ||
		(expiresAtCeiling && expiresAtCeiling < session.access_expires_at)
	) {
		const slidingExpires =
			session.kind === "browser" && Date.parse(session.access_expires_at) - now < org.session_ttl_seconds * 500
				? new Date(now + org.session_ttl_seconds * 1000).toISOString()
				: session.access_expires_at;
		const expires = expiresAtCeiling && expiresAtCeiling < slidingExpires ? expiresAtCeiling : slidingExpires;
		if (expires !== session.access_expires_at) {
			await organizationWrite([
				statement(
					"UPDATE auth_sessions SET last_used_at = ?,access_expires_at = ? WHERE id = ? AND revoked_at IS NULL AND ((last_used_at IS NULL OR last_used_at <= ?) OR access_expires_at>?)",
					[new Date(now).toISOString(), expires, session.id, new Date(now - 60_000).toISOString(), expires],
				),
			]);
		} else await recordAuthObservation("session", session.id, new Date(now).toISOString());
		currentSession = { ...session, access_expires_at: expires, last_used_at: new Date(now).toISOString() };
	}
	return {
		principal,
		user,
		session: currentSession,
		slid: currentSession.access_expires_at !== session.access_expires_at,
	};
}
export function refreshSession(token: string) {
	return rotateSession(token, true);
}
async function rotateSession(
	token: string,
	retryOnConflict: boolean,
): Promise<{
	accessToken: string;
	refreshToken: string;
	accessExpiresAt: string;
	refreshExpiresAt: string;
	sessionId: string;
	deviceId: string | null;
	user: ReturnType<typeof userView>;
}> {
	const parsed = parseSessionToken(token, "ref");
	if (!parsed) throw new IdentityError(401, "invalid_credential");
	const row = await organizationQuery<SessionRow | null>(
		statement("SELECT * FROM auth_sessions WHERE id = ?", [parsed.sessionId], "get"),
	);
	if (!row || row.kind === "browser" || !row.refresh_hash) throw new IdentityError(401, "invalid_credential");
	if (row.revoked_at) throw new IdentityError(401, "revoked");
	if (!row.refresh_expires_at || row.refresh_expires_at <= new Date().toISOString())
		throw new IdentityError(401, "expired");
	const user = await activeUser(row.user_id, row.device_id);
	const limits = await sessionKeyLimits(row);
	if (!matchesHash(parsed.secret, row.refresh_hash)) {
		const replay = replayRefreshRetry(row.refresh_retry_json, token, row.id, row.token_hash, row.refresh_hash);
		if (replay) {
			await organizationWrite([auditStatement(null, "session.refresh_replayed", "session", row.id)]);
			return { ...replay, sessionId: row.id, deviceId: row.device_id, user: userView(user) };
		}
		const consumed = await organizationQuery(
			statement(
				"SELECT 1 FROM audit_events WHERE action = 'session.refreshed' AND target_id = ? AND json_extract(detail_json,'$.previousRefreshHash') = ? LIMIT 1",
				[row.id, digest(parsed.secret)],
				"get",
			),
		);
		if (!consumed) throw new IdentityError(401, "invalid_credential");
		await organizationWrite([
			statement(
				"UPDATE auth_sessions SET revoked_at = ?,revoked_reason = 'refresh_reuse',refresh_retry_json = '[]' WHERE id = ?",
				[new Date().toISOString(), row.id],
			),
			auditStatement(null, "session.refresh_reuse", "session", row.id),
		]);
		throw new IdentityError(401, "refresh_reuse");
	}
	const org = await readOrganization();
	const access = secret();
	const refresh = secret();
	const accessExpiry = new Date(Date.now() + org.access_ttl_seconds * 1000).toISOString();
	const refreshExpiry = new Date(Date.now() + org.refresh_ttl_seconds * 1000).toISOString();
	const accessExpiresAt = limits?.expiresAt && limits.expiresAt < accessExpiry ? limits.expiresAt : accessExpiry;
	const refreshExpiresAt = limits?.expiresAt && limits.expiresAt < refreshExpiry ? limits.expiresAt : refreshExpiry;
	const retryState = appendRefreshRetry(token, row.id, row.refresh_hash, {
		accessToken: `sig_ses_${row.id}_${access}`,
		refreshToken: `sig_ref_${row.id}_${refresh}`,
		accessExpiresAt,
		refreshExpiresAt,
	});
	try {
		await organizationWrite([
			{
				...statement(
					"UPDATE auth_sessions SET token_hash = ?,refresh_hash = ?,access_expires_at = ?,refresh_expires_at = ?,last_used_at = ?,refresh_retry_json = ? WHERE id = ? AND refresh_hash = ? AND revoked_at IS NULL",
					[
						digest(access),
						digest(refresh),
						accessExpiresAt,
						refreshExpiresAt,
						new Date().toISOString(),
						retryState,
						row.id,
						row.refresh_hash,
					],
				),
				requireChanges: true,
			},
			auditStatement(
				await userPrincipal(user, { kind: "session", id: row.id }, row.id, row.device_id),
				"session.refreshed",
				"session",
				row.id,
				{ previousRefreshHash: row.refresh_hash },
			),
		]);
	} catch (error) {
		if (
			retryOnConflict &&
			error instanceof Error &&
			error.message === "DB owner transaction precondition changed zero rows"
		)
			return rotateSession(token, false);
		throw error;
	}

	return {
		accessToken: `sig_ses_${row.id}_${access}`,
		refreshToken: `sig_ref_${row.id}_${refresh}`,
		accessExpiresAt,
		refreshExpiresAt,
		sessionId: row.id,
		deviceId: row.device_id,
		user: userView(user),
	};
}
export async function connectorErrorHistory(
	input: import("./audit-owner").ConnectorErrorRequest,
): Promise<readonly { at: string; status: number; reason: string }[]> {
	const { getDbOwner } = await import("../db-owner-runtime");
	return (await getDbOwner()).submit<readonly { at: string; status: number; reason: string }[]>(
		{ kind: "connector_errors", input },
		{ operation: "organization.connector-errors", lane: "write", deadlineMs: 10_000, estimatedWorkUnits: 10 },
	).result;
}
export async function recordConnectorError(
	keyId: string,
	status: 401 | 403,
	reason: string,
	requestId: string,
): Promise<void> {
	await connectorErrorHistory({ keyId, record: { status, reason, requestId } });
}

export interface BoundKeyRow {
	id: string;
	user_id: string | null;
	device_id: string | null;
	session_id: string | null;
	kind: string;
	legacy: number;
	harness: string | null;
	agent_id: string | null;
	allowed_projects_json: string | null;
	permissions_json: string;
	scope_json: string;
	expires_at: string | null;
	revoked_at: string | null;
}
export async function readBoundKey(keyId: string): Promise<BoundKeyRow | null> {
	const key = await organizationQuery<
		(BoundKeyRow & { ancestors_live: number; ancestor_expires_at: string | null }) | null
	>(
		statement(
			`WITH RECURSIVE ancestry(id,parent_key_id,user_id,expires_at,revoked_at,depth) AS (
				SELECT id,parent_key_id,user_id,expires_at,revoked_at,0 FROM api_keys WHERE id=?
				UNION ALL SELECT p.id,p.parent_key_id,p.user_id,p.expires_at,p.revoked_at,a.depth+1 FROM ancestry a JOIN api_keys p ON p.id=a.parent_key_id WHERE a.depth<64
			) SELECT id,user_id,device_id,session_id,kind,legacy,harness,agent_id,allowed_projects_json,permissions_json,scope_json,expires_at,revoked_at,
			(SELECT min(expires_at) FROM ancestry WHERE depth>0) AS ancestor_expires_at,
			NOT EXISTS(SELECT 1 FROM ancestry a WHERE a.depth>=64 OR (a.depth>0 AND (a.revoked_at IS NOT NULL OR a.user_id IS NOT api_keys.user_id)) OR (a.parent_key_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM api_keys p WHERE p.id=a.parent_key_id))) AS ancestors_live
			FROM api_keys WHERE id=?`,
			[keyId, keyId],
			"get",
		),
	);
	if (
		key &&
		(!key.ancestors_live || (key.ancestor_expires_at !== null && key.ancestor_expires_at <= new Date().toISOString()))
	)
		throw new IdentityError(401, "invalid_credential");
	return key;
}
export async function renewConnectorKey(key: BoundKeyRow, org: OrganizationRow): Promise<void> {
	if (
		key.kind !== "connector" ||
		!key.expires_at ||
		Date.parse(key.expires_at) - Date.now() >= org.connector_key_ttl_seconds * 500 ||
		!key.session_id
	)
		return;
	await organizationWrite([
		statement(
			"UPDATE api_keys SET expires_at = ? WHERE id = ? AND expires_at = ? AND revoked_at IS NULL AND EXISTS (SELECT 1 FROM auth_sessions s JOIN users u ON u.id = s.user_id WHERE s.id = api_keys.session_id AND s.revoked_at IS NULL AND s.refresh_expires_at > ? AND u.status = 'active')",
			[
				new Date(Date.now() + org.connector_key_ttl_seconds * 1000).toISOString(),
				key.id,
				key.expires_at,
				new Date().toISOString(),
			],
		),
	]);
}
export async function createOrganizationKey(
	p: Principal,
	input: {
		name: string;
		kind: "connector" | "personal" | "shared";
		agentId: string | null;
		deviceId: string | null;
		harness: string | null;
		permissions: readonly Permission[];
		expiresAt: string;
		allowedProjects?: readonly string[];
	},
) {
	if (!p.userId) throw new IdentityError(403, "org_policy");
	if (input.permissions.some((permission) => !p.permissions.has(permission)))
		throw new IdentityError(403, "permission");
	const parent = p.credential.kind === "api_key" ? await readBoundKey(p.credential.id) : null;
	if (
		p.credential.kind === "api_key" &&
		(!parent || parent.revoked_at || (parent.expires_at && parent.expires_at <= new Date().toISOString()))
	)
		throw new IdentityError(401, "invalid_credential");
	const expiresAt = parent?.expires_at && parent.expires_at < input.expiresAt ? parent.expires_at : input.expiresAt;
	if (input.deviceId) await activeUser(p.userId, input.deviceId);
	const keyId = id("key"),
		prefix = randomBytes(6).toString("hex"),
		key = `sig_sk_${prefix}_${secret()}`,
		salt = randomBytes(16).toString("hex");
	const hash = await new Promise<Buffer>((resolve, reject) =>
		scrypt(key, salt, 32, (error, result) => (error ? reject(error) : resolve(result))),
	);
	await organizationWrite(
		[
			{
				...statement(
					"INSERT INTO api_keys (id,prefix,name,key_hash,role,scope_json,permissions_json,harness,agent_id,allowed_projects_json,created_at,expires_at,user_id,device_id,session_id,kind,legacy,parent_key_id) SELECT ?,?,?,?,'member',?,?,?,?,?,?,?,?,?,?,?,0,? WHERE ? IS NULL OR EXISTS(SELECT 1 FROM api_keys WHERE id=? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>?))",
					[
						keyId,
						prefix,
						input.name,
						`scrypt:${salt}:${hash.toString("hex")}`,
						JSON.stringify({ user: p.userId, agent: input.agentId ?? undefined }),
						JSON.stringify(input.permissions),
						input.harness,
						input.agentId,
						input.allowedProjects ? JSON.stringify(input.allowedProjects) : null,
						new Date().toISOString(),
						expiresAt,
						p.userId,
						input.deviceId,
						p.sessionId,
						input.kind,
						parent?.id ?? null,
						parent?.id ?? null,
						parent?.id ?? null,
						new Date().toISOString(),
					],
				),
				requireChanges: true,
			},
			auditStatement(p, "key.created", "key", keyId),
		],
		401,
	);
	return {
		key: {
			id: keyId,
			prefix,
			harness: input.harness,
			agentId: input.agentId,
			deviceId: input.deviceId,
			expiresAt,
		},
		secret: key,
	};
}

export async function bindHookSpeaker(
	p: Principal,
	sessionKey: string,
	agentId: string,
	harness: string,
	project: string | null,
): Promise<void> {
	const previous = await organizationQuery<{ speaker_user_id: string | null } | null>(
		statement(
			"SELECT speaker_user_id FROM session_transcripts WHERE agent_id = ? AND session_key = ?",
			[agentId, sessionKey],
			"get",
		),
	);
	if (previous?.speaker_user_id && previous.speaker_user_id !== p.userId)
		throw new IdentityError(403, "actor_conflict");
	if (previous?.speaker_user_id === p.userId) return;
	await organizationWrite([
		{
			...statement(
				"INSERT INTO session_transcripts (agent_id,session_key,content,harness,project,created_at,speaker_user_id,compartment_id) VALUES (?,?,'',?,?,?,?,?) ON CONFLICT(agent_id,session_key) DO UPDATE SET speaker_user_id = excluded.speaker_user_id,compartment_id=excluded.compartment_id WHERE session_transcripts.speaker_user_id IS NULL OR session_transcripts.speaker_user_id = excluded.speaker_user_id",
				[
					agentId,
					sessionKey,
					harness,
					project,
					new Date().toISOString(),
					p.userId,
					{ type: "compartment", scope: { agentId, sessionKey } },
				],
			),
			requireChanges: true,
		},
		auditStatement(p, "session.speaker_bound", "session", sessionKey, { agentId }),
	]);
}
