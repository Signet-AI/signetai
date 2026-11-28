import { randomBytes } from "node:crypto";
import { z } from "zod";
import type { DbOwnerStatement } from "../db-owner-protocol";
import { principalAccess, resolveReadAgent, resolveWriteAgent } from "./agent-access";
import {
	activeUser,
	auditStatement,
	bindRequestedReadAgent,
	createOrganizationKey,
	digest,
	IdentityError,
	id,
	issueSession,
	type OrganizationRow,
	organizationQuery,
	organizationWrite,
	passwordHash,
	personalAgentStatements,
	readBoundKey,
	readOrganization,
	resolveSessionPrincipal,
	sourceSessionBinding,
	readUser,
	type SessionRow,
	secret,
	sessionMaterial,
	statement,
	type UserRow,
	userView,
	verifyUserPassword,
} from "./organization-store";
import type { Principal } from "./principal";
import { PERMISSIONS, type Permission } from "./types";

interface DashboardHandoff {
	readonly sessionId: string;
	readonly userId: string;
	readonly deviceId: string | null;
	readonly expiresAt: number;
}
const dashboardHandoffs = new Map<string, DashboardHandoff>();
export async function createDashboardHandoff(p: Principal) {
	const user = requireUser(p);
	if (p.credential.kind !== "session" || !p.sessionId)
		throw new IdentityError(403, "permission", "Requires a signed-in user session");
	const now = Date.now();
	for (const [key, entry] of dashboardHandoffs) {
		if (entry.expiresAt <= now) dashboardHandoffs.delete(key);
	}
	const pending = [...dashboardHandoffs.values()].filter((entry) => entry.sessionId === p.sessionId).length;
	const principalPending = [...dashboardHandoffs.values()].filter((entry) => entry.userId === p.userId).length;
	if (dashboardHandoffs.size >= 1000 || pending >= 5 || principalPending >= 20)
		throw new IdentityError(429, "rate_limit");
	const code = secret();
	const expiresAt = now + 60_000;
	dashboardHandoffs.set(digest(code), { sessionId: p.sessionId, userId: user.userId, deviceId: p.deviceId, expiresAt });
	try {
		await organizationWrite([auditStatement(p, "session.handoff_created", "session", p.sessionId)]);
	} catch (error) {
		dashboardHandoffs.delete(digest(code));
		throw error;
	}
	return { code, expiresAt: new Date(expiresAt).toISOString() };
}
export async function redeemDashboardHandoff(input: unknown) {
	const { code, confirm } = z
		.object({ code: z.string().min(20).max(256), confirm: z.literal(true).optional() })
		.strict()
		.parse(input);
	const key = digest(code);
	const entry = dashboardHandoffs.get(key);
	if (confirm) dashboardHandoffs.delete(key);
	if (!entry || entry.expiresAt <= Date.now()) throw new IdentityError(401, "invalid_credential");
	const source = await organizationQuery<SessionRow | null>(
		statement("SELECT * FROM auth_sessions WHERE id=? AND user_id=?", [entry.sessionId, entry.userId], "get"),
	);
	if (!source) throw new IdentityError(401, "invalid_credential");
	const org = await readOrganization();
	const { user, expiresAtCeiling } = await resolveSessionPrincipal(source, org);
	if (!confirm) return { confirmationRequired: true as const, user: userView(user), organization: { name: org.name } };
	const binding = sourceSessionBinding(source);
	const material = sessionMaterial(
		user.id,
		"browser",
		entry.deviceId,
		org,
		binding && {
			sourceKeyId: binding.sourceKeyId,
			ceiling: { ...binding.ceiling, expiresAt: expiresAtCeiling ?? binding.ceiling.expiresAt },
		},
	);
	await organizationWrite(
		[
			{
				...statement(
					"UPDATE auth_sessions SET last_used_at=? WHERE id=? AND user_id=? AND revoked_at IS NULL AND access_expires_at>?",
					[new Date().toISOString(), entry.sessionId, user.id, new Date().toISOString()],
				),
				requireChanges: true,
			},
			...material.statements,
			auditStatement(null, "session.handoff_redeemed", "session", material.sessionId, {
				userId: user.id,
				sourceSessionId: entry.sessionId,
			}),
		],
		401,
	);
	const { statements: _statements, ...result } = material;
	return { ...result, user: userView(user) };
}

export const roleSchema = z.enum(["admin", "operator", "member", "readonly"]);
const text = z.string().trim().min(1).max(128);
export function requireUser(p: Principal | undefined): Principal & { userId: string } {
	if (!p || p.kind !== "user" || !p.userId) throw new IdentityError(401, "missing_credential");
	return { ...p, userId: p.userId };
}
export function requireAdmin(p: Principal): void {
	if (p.role !== "admin" || !p.permissions.has("admin"))
		throw new IdentityError(403, "permission", "Requires the admin role");
}
export function requireAudit(p: Principal): void {
	if (!p.permissions.has("audit")) throw new IdentityError(403, "permission", "Requires the audit permission");
}
export async function updatePreferences(p: Principal, input: unknown) {
	const user = requireUser(p);
	if (p.credential.kind !== "session" || p.sourceKeyId)
		throw new IdentityError(403, "permission", "Requires a signed-in user session");
	const data = z.object({ defaultReadAgentId: text }).strict().parse(input);
	await bindRequestedReadAgent(p, data.defaultReadAgentId);
	const target = resolveReadAgent(p, data.defaultReadAgentId);
	if (!target.ok) throw new IdentityError(target.error.status, target.error.reason);
	await organizationWrite([
		statement("UPDATE users SET default_read_agent_id=?,updated_at=? WHERE id=? AND status='active'", [
			data.defaultReadAgentId,
			new Date().toISOString(),
			user.userId,
		]),
		auditStatement(p, "user.preferences_updated", "user", user.userId, data),
	]);
	return { defaultReadAgentId: data.defaultReadAgentId };
}

export const ORGANIZATION_VISIBILITY_VERSION = "organization-visibility-v1";
function onboardingIdentity(p: Principal) {
	const identity = requireUser(p);
	if (p.credential.kind !== "session" || p.sourceKeyId || p.boundAgentId || p.allowedProjects)
		throw new IdentityError(403, "permission", "Requires an unrestricted signed-in user session");
	return identity;
}
export async function onboardingStatus(p: Principal) {
	const identity = onboardingIdentity(p);
	const acknowledged = await organizationQuery<{ id: string } | null>(
		statement(
			"SELECT id FROM audit_events WHERE actor_user_id=? AND action='user.visibility_acknowledged' AND json_extract(detail_json,'$.version')=? LIMIT 1",
			[identity.userId, ORGANIZATION_VISIBILITY_VERSION],
			"get",
		),
	);
	const completed = acknowledged
		? await organizationQuery<{ id: string } | null>(
				statement(
					"SELECT id FROM audit_events WHERE actor_user_id=? AND action='user.onboarding_completed' AND json_extract(detail_json,'$.version')=? LIMIT 1",
					[identity.userId, ORGANIZATION_VISIBILITY_VERSION],
					"get",
				),
			)
		: null;
	return {
		version: ORGANIZATION_VISIBILITY_VERSION,
		acknowledged: Boolean(acknowledged),
		complete: Boolean(completed),
	};
}
export async function updateOnboarding(p: Principal, input: unknown) {
	const identity = onboardingIdentity(p);
	const data = z
		.discriminatedUnion("action", [
			z.object({ action: z.literal("acknowledge"), version: z.literal(ORGANIZATION_VISIBILITY_VERSION) }).strict(),
			z.object({ action: z.literal("complete") }).strict(),
		])
		.parse(input);
	const current = await onboardingStatus(p);
	if (data.action === "complete" && !current.acknowledged)
		throw new IdentityError(409, "visibility_acknowledgement_required");
	if (data.action === "acknowledge" ? !current.acknowledged : !current.complete)
		await organizationWrite([
			auditStatement(
				p,
				data.action === "acknowledge" ? "user.visibility_acknowledged" : "user.onboarding_completed",
				"user",
				identity.userId,
				{ version: ORGANIZATION_VISIBILITY_VERSION },
			),
		]);
	return onboardingStatus(p);
}

export async function profile(p: Principal) {
	const identity = requireUser(p);
	const user = await activeUser(identity.userId, p.deviceId);
	return {
		user: userView(user),
		identityProvider: user.oidc_issuer ? { kind: "oidc", issuer: user.oidc_issuer } : null,
		editableFields: user.oidc_issuer ? [] : ["displayName"],
	};
}
export async function updateProfile(p: Principal, input: unknown) {
	const identity = requireUser(p);
	if (p.credential.kind !== "session" || p.sourceKeyId)
		throw new IdentityError(403, "permission", "Requires a signed-in user session");
	if (typeof input === "object" && input !== null && Object.hasOwn(input, "email"))
		throw new IdentityError(403, "email_change_requires_admin");
	const data = z.object({ displayName: text.optional() }).strict().parse(input);
	const user = await activeUser(identity.userId, p.deviceId);
	if (user.oidc_issuer)
		throw new IdentityError(403, "org_policy", "Your identity provider manages your name and email");
	await organizationWrite(
		[
			{
				...statement(
					"UPDATE users SET display_name=COALESCE(?,display_name),updated_at=? WHERE id=? AND status='active' AND oidc_issuer IS NULL",
					[data.displayName ?? null, new Date().toISOString(), identity.userId],
				),
				requireChanges: true,
			},
			auditStatement(p, "user.profile_updated", "user", identity.userId, { fields: Object.keys(data) }),
		],
		409,
	);
	return profile(p);
}

export async function passwordLogin(input: unknown) {
	const data = z
		.object({ username: text, password: z.string().min(1).max(1024), client: z.literal("browser").optional() })
		.parse(input);
	const org = await readOrganization();
	if (!org.password_login || org.require_sso) throw new IdentityError(403, "org_policy");
	const user = await organizationQuery<UserRow | null>(
		statement("SELECT * FROM users WHERE username = ?", [data.username], "get"),
	);
	const valid = await verifyUserPassword(data.password, user?.password_hash ?? null);
	if (!user || !valid) throw new IdentityError(401, "invalid_credential");
	await activeUser(user.id, null);
	return issueSession(user.id, "browser");
}
export function authProviders(org: OrganizationRow) {
	return [
		...(org.password_login && !org.require_sso ? [{ id: "password" }] : []),
		...(org.oidc_json ? [{ id: "oidc", label: "Single sign-on", startPath: "/api/auth/sso/start" }] : []),
	];
}
export async function whoami(p: Principal | undefined, org: OrganizationRow, hybridProxyDetected: boolean) {
	const u = p?.userId ? await readUser(p.userId) : null;
	const groups = u
		? await organizationQuery<{ id: string; name: string; role: string; managedBy: string }[]>(
				statement(
					"SELECT g.id,g.name,m.role,m.managed_by AS managedBy FROM groups g JOIN group_members m ON m.group_id = g.id WHERE m.user_id = ?",
					[u.id],
					"all",
				),
			)
		: [];
	const session =
		p?.credential.kind === "session"
			? await organizationQuery<SessionRow | null>(
					statement("SELECT * FROM auth_sessions WHERE id = ?", [p.credential.id], "get"),
				)
			: null;
	const key =
		p?.credential.kind === "api_key"
			? await organizationQuery<{ expires_at: string | null; kind: string } | null>(
					statement("SELECT expires_at,kind FROM api_keys WHERE id = ?", [p.credential.id], "get"),
				)
			: null;
	return {
		authenticated: Boolean(p),
		mode: "team",
		effectiveAccess: Boolean(p),
		accessMode: p ? "authenticated" : "none",
		organization: { name: org.name, agentModel: org.agent_model },
		user: u ? { ...userView(u), groups } : null,
		credential: p
			? {
					...p.credential,
	const visibleAgents = p ? principalAccess(p)?.agents : undefined;
	const visibleDefault = (agentId: string | null) =>
		visibleAgents?.some((agent) => agent.id === agentId) ? agentId : null;
					keyKind: key?.kind ?? null,
					agentId: p.boundAgentId,
					expiresAt: session?.access_expires_at ?? key?.expires_at ?? null,
					deviceId: p.deviceId,
					harness: p.harness,
				}
			: null,
		permissions: p ? [...p.permissions] : [],
		agents: {
			defaultRead:
				visibleDefault(p?.boundAgentId ?? u?.default_read_agent_id ?? "default") ?? visibleDefault("default"),
			defaultWrite: visibleDefault(org.agent_model === "personal" ? (u?.personal_agent_id ?? null) : "default"),
		},
		hybridProxyDetected,
		providers: authProviders(org),
	};
}
function requireSessionManagement(p: Principal): void {
	if ((p.credential.kind !== "session" || p.sourceKeyId) && !p.permissions.has("admin"))
		throw new IdentityError(
			403,
			"permission",
			"Requires an interactive session or the admin session-management permission",
		);
}
export async function logout(p: Principal, input: unknown) {
	const data = z.object({ all: z.boolean().optional() }).parse(input);
	if (data.all) requireSessionManagement(p);
	await organizationWrite([
		statement(
			`UPDATE auth_sessions SET revoked_at = ?,revoked_reason = 'logout',refresh_retry_json = '[]' WHERE ${data.all ? "user_id" : "id"} = ? AND revoked_at IS NULL`,
			[new Date().toISOString(), data.all ? p.userId : p.credential.kind === "session" ? p.sessionId : null],
		),
		auditStatement(p, "session.logout", "user", p.userId),
	]);
	return { ok: true };
}
export async function listSessions(p: Principal) {
	return {
		sessions: await organizationQuery(
			statement(
				"SELECT id,kind,device_id,created_at,last_used_at,access_expires_at,refresh_expires_at,revoked_at,revoked_reason,user_agent,ip FROM auth_sessions WHERE user_id = ? ORDER BY created_at DESC LIMIT 1000",
				[p.userId],
				"all",
			),
		),
	};
}
export async function revokeSession(p: Principal, sessionId: string) {
	const row = await organizationQuery<SessionRow | null>(
		statement("SELECT * FROM auth_sessions WHERE id = ?", [sessionId], "get"),
	);
	if (!row) throw new IdentityError(404, "not_found");
	if (row.user_id !== p.userId) requireAdmin(p);
	await organizationWrite([
		statement(
			"UPDATE auth_sessions SET revoked_at = ?,revoked_reason = 'revoked',refresh_retry_json = '[]' WHERE id = ?",
			[new Date().toISOString(), row.id],
		),
		auditStatement(p, "session.revoked", "session", row.id),
	]);
	return { ok: true };
}
interface DeviceAuthorization {
	id: string;
	device_code_hash: string;
	user_code: string;
	client: "cli" | "desktop";
	device_name: string;
	platform: string | null;
	status: string;
	user_id: string | null;
	session_id: string | null;
	created_at: string;
	expires_at: string;
	last_polled_at: string | null;
}
export async function deviceStart(input: unknown, origin: string) {
	const data = z
		.object({ client: z.enum(["cli", "desktop"]), deviceName: text, platform: text.optional() })
		.parse(input);
	const deviceCode = secret();
	const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
	const code = Array.from(randomBytes(8), (b) => alphabet[b % alphabet.length]).join("");
	const userCode = `${code.slice(0, 4)}-${code.slice(4)}`;
	const org = await readOrganization();
	const base = org.public_url ?? origin;
	const verificationUri = `${base}/auth/device`;
	const now = new Date().toISOString();
	await organizationWrite(
		[
			{
				...statement(
					"INSERT INTO device_authorizations (id,device_code_hash,user_code,client,device_name,platform,status,created_at,expires_at) SELECT ?,?,?,?,?,?,'pending',?,? WHERE (SELECT COUNT(*) FROM (SELECT 1 FROM device_authorizations WHERE status IN ('pending','approved') AND expires_at > ? LIMIT 1000)) < 1000",
					[
						id("dev"),
						digest(deviceCode),
						userCode,
						data.client,
						data.deviceName,
						data.platform ?? null,
						now,
						new Date(Date.now() + 600_000).toISOString(),
						now,
					],
				),
				requireChanges: true,
			},
			auditStatement(null, "device.authorization_started"),
		],
		429,
	);
	return {
		deviceCode,
		userCode,
		verificationUri,
		verificationUriComplete: `${verificationUri}?user_code=${userCode}`,
		interval: 2,
		expiresIn: 600,
	};
}
export async function deviceInfo(userCode: string) {
	const row = await organizationQuery<DeviceAuthorization | null>(
		statement("SELECT * FROM device_authorizations WHERE user_code = ?", [userCode.toUpperCase()], "get"),
	);
	if (!row || row.expires_at <= new Date().toISOString()) throw new IdentityError(410, "expired");
	return row;
}
export async function deviceApprove(p: Principal, input: unknown) {
	if (p.credential.kind !== "session" || p.sourceKeyId)
		throw new IdentityError(403, "org_policy", "Requires an interactive user session");
	const data = z.object({ userCode: text, decision: z.enum(["approve", "deny"]) }).parse(input);
	const row = await deviceInfo(data.userCode);
	if (row.status !== "pending") throw new IdentityError(409, "already_decided");
	const now = new Date().toISOString();
	const deviceId = id("dev");
	const org = await readOrganization();
	const approver = await organizationQuery<SessionRow | null>(
		statement("SELECT * FROM auth_sessions WHERE id=?", [p.sessionId], "get"),
	);
	if (!approver) throw new IdentityError(401, "invalid_credential");
	await resolveSessionPrincipal(approver, org);
	const session = sessionMaterial(requireUser(p).userId, row.client, deviceId, org, {
		sourceKeyId: null,
		ceiling: {
			permissions: [...p.permissions],
			agentId: p.boundAgentId,
			projects: p.allowedProjects ? [...p.allowedProjects] : null,
			expiresAt: approver.refresh_expires_at ?? approver.access_expires_at,
		},
	});
	const writes: DbOwnerStatement[] = [
		{
			...statement(
				"UPDATE device_authorizations SET status = ?,user_id = ?,session_id = ?,approved_at = ? WHERE id = ? AND status = 'pending'",
				[
					data.decision === "approve" ? "approved" : "denied",
					p.userId,
					data.decision === "approve" ? session.sessionId : null,
					now,
					row.id,
				],
			),
			requireChanges: true,
		},
	];
	if (data.decision === "approve")
		writes.push(
			statement("INSERT INTO devices (id,user_id,name,platform,created_at,last_seen_at) VALUES (?,?,?,?,?,?)", [
				deviceId,
				p.userId,
				row.device_name,
				row.platform,
				now,
				now,
			]),
			...session.statements,
		);
	writes.push(auditStatement(p, `device.${data.decision}`, "device_authorization", row.id));
	await organizationWrite(writes);
	return { ok: true };
}
export async function deviceToken(input: unknown) {
	const data = z.object({ deviceCode: z.string().min(20).max(256) }).parse(input);
	const row = await organizationQuery<DeviceAuthorization | null>(
		statement("SELECT * FROM device_authorizations WHERE device_code_hash = ?", [digest(data.deviceCode)], "get"),
	);
	if (!row) throw new IdentityError(401, "invalid_credential");
	if (row.expires_at <= new Date().toISOString()) throw new IdentityError(410, "expired");
	if (row.status === "denied") throw new IdentityError(403, "denied");
	if (row.status === "consumed") throw new IdentityError(401, "invalid_credential");
	if (row.status === "pending") {
		if (row.last_polled_at && Date.parse(row.last_polled_at) > Date.now() - 2000)
			throw new IdentityError(429, "slow_down");
		await organizationWrite([
			statement("UPDATE device_authorizations SET last_polled_at = ? WHERE id = ?", [new Date().toISOString(), row.id]),
		]);
		throw new IdentityError(428, "authorization_pending");
	}
	if (!row.user_id || !row.session_id) throw new IdentityError(401, "invalid_credential");
	const session = await organizationQuery<SessionRow | null>(
		statement("SELECT * FROM auth_sessions WHERE id = ?", [row.session_id], "get"),
	);
	if (!session || session.revoked_at) throw new IdentityError(401, "revoked");
	const user = await activeUser(row.user_id, session.device_id);
	const org = await readOrganization();
	const material = sessionMaterial(user.id, row.client, session.device_id, org, sourceSessionBinding(session));
	await organizationWrite(
		[
			{
				...statement("UPDATE device_authorizations SET status = 'consumed' WHERE id = ? AND status = 'approved'", [
					row.id,
				]),
				requireChanges: true,
			},
			statement(
				"UPDATE auth_sessions SET revoked_at = ?,revoked_reason = 'device_exchange',refresh_retry_json = '[]' WHERE id = ?",
				[new Date().toISOString(), session.id],
			),
			...material.statements,
			auditStatement(null, "device.token_issued", "device", session.device_id),
		],
		401,
	);
	const { statements: _statements, ...result } = material;
	return { ...result, user: userView(user) };
}
export async function devices(p: Principal) {
	const rows = await organizationQuery<Record<string, unknown>[]>(
		statement(
			"SELECT id,name,platform,created_at,last_seen_at,revoked_at FROM devices WHERE user_id = ? ORDER BY created_at DESC LIMIT 1000",
			[p.userId],
			"all",
		),
	);
	const keys = await listKeys(p, false, "connector");
	return { devices: rows.map((d) => ({ ...d, keys: keys.filter((k) => k.device_id === d.id) })) };
}
export async function changeDevice(p: Principal, deviceId: string, input: unknown | null) {
	const device = await organizationQuery<{ user_id: string } | null>(
		statement("SELECT user_id FROM devices WHERE id = ?", [deviceId], "get"),
	);
	if (!device) throw new IdentityError(404, "not_found");
	if (device.user_id !== p.userId) throw new IdentityError(403, "not_owner");
	const now = new Date().toISOString();
	const writes =
		input === null
			? [
					statement("UPDATE devices SET revoked_at = ? WHERE id = ?", [now, deviceId]),
					statement(
						"UPDATE auth_sessions SET revoked_at = ?,revoked_reason = 'device_revoked',refresh_retry_json = '[]' WHERE device_id = ?",
						[now, deviceId],
					),
					statement("UPDATE api_keys SET revoked_at = ? WHERE device_id = ?", [now, deviceId]),
				]
			: [statement("UPDATE devices SET name = ? WHERE id = ?", [z.object({ name: text }).parse(input).name, deviceId])];
	await organizationWrite([
		...writes,
		auditStatement(p, input === null ? "device.revoked" : "device.renamed", "device", deviceId),
	]);
	return { ok: true };
}
export async function listKeys(p: Principal, all = false, kind?: string): Promise<Record<string, unknown>[]> {
	if (all) requireAdmin(p);
	return organizationQuery(
		statement(
			`SELECT id,prefix,name,role,harness,agent_id,device_id,user_id,kind,legacy,created_at,last_used_at,revoked_at,expires_at FROM api_keys WHERE ${all ? "1=1" : "user_id = ?"}${kind ? " AND kind = ?" : ""} ORDER BY created_at DESC LIMIT 1000`,
			[...(all ? [] : [p.userId]), ...(kind ? [kind] : [])],
			"all",
		),
	);
}
export async function createKey(p: Principal, input: unknown, connector: boolean) {
	if (p.sourceKeyId)
		throw new IdentityError(403, "org_policy", "Key-derived browser sessions cannot issue credentials");
	const data = z
		.object({
			name: text.optional(),
			harness: text.optional(),
			deviceId: text.optional(),
			agentId: text.optional(),
			kind: z.enum(["personal", "shared"]).optional(),
			permissions: z.array(z.enum(PERMISSIONS)).max(PERMISSIONS.length).optional(),
			expiresAt: z.iso.datetime().optional(),
			allowedProjects: z.array(text).max(100).optional(),
		})
		.parse(input);
	if (connector && (p.credential.kind !== "session" || p.sourceKeyId || !data.deviceId || !data.harness))
		throw new IdentityError(403, "org_policy", "A user session, harness, and device are required");
	const org = await readOrganization();
	let agentId = data.agentId ?? p.boundAgentId;
	if (p.deviceId && data.deviceId && p.deviceId !== data.deviceId) throw new IdentityError(403, "org_policy");
	if (p.harness && data.harness && p.harness !== data.harness) throw new IdentityError(403, "org_policy");
	if (p.allowedProjects && data.allowedProjects?.some((project) => !p.allowedProjects?.includes(project)))
		throw new IdentityError(403, "project_not_permitted");
	const allowedProjects = data.allowedProjects ?? p.allowedProjects ?? undefined;
	const access = principalAccess(p);
	if (!access) throw new IdentityError(403, "org_policy");
	if (connector || (agentId && data.kind !== "shared")) {
		const resolved = resolveWriteAgent(p, data.agentId, access);
		if (!resolved.ok) throw new IdentityError(resolved.error.status, resolved.error.reason);
		agentId = resolved.value;
	}
	if (data.kind === "shared") {
		if (!data.agentId) throw new IdentityError(400, "agent_required");
		await bindRequestedReadAgent(p, data.agentId);
		const agent = principalAccess(p)?.agents.find((a) => a.id === data.agentId);
		if (!agent || agent.archived_at) throw new IdentityError(403, "agent_not_permitted");
		if (p.role !== "admin" && (!agent?.owner_group_id || !(await groupOwner(p, agent.owner_group_id))))
			throw new IdentityError(403, "not_owner");
	}
	const permissions: readonly Permission[] = connector
		? (["recall", "remember", "documents", "modify"] as const).filter((v) => p.permissions.has(v))
		: (data.permissions ?? []);
	if (!connector && !data.permissions) throw new IdentityError(400, "permissions_required");
	if (!connector && !data.expiresAt) throw new IdentityError(400, "expiry_required");
	const expiresAt = connector
		? new Date(Date.now() + org.connector_key_ttl_seconds * 1000).toISOString()
		: (data.expiresAt ?? "");
	if (Date.parse(expiresAt) <= Date.now()) throw new IdentityError(400, "invalid_expiry");
	return createOrganizationKey(p, {
		name: data.name ?? `${data.harness} connector`,
		kind: connector ? "connector" : (data.kind ?? "personal"),
		deviceId: data.deviceId ?? p.deviceId,
		harness: data.harness ?? p.harness,
		agentId,
		permissions,
		expiresAt,
		allowedProjects,
	});
}
export async function revokeKey(p: Principal, keyId: string) {
	const key = await organizationQuery<{ user_id: string | null } | null>(
		statement("SELECT user_id FROM api_keys WHERE id = ?", [keyId], "get"),
	);
	if (!key) throw new IdentityError(404, "not_found");
	if (key.user_id !== p.userId) requireAdmin(p);
	await organizationWrite([
		statement("UPDATE api_keys SET revoked_at = ? WHERE id = ?", [new Date().toISOString(), keyId]),
		auditStatement(p, "key.revoked", "key", keyId),
	]);
	return { ok: true };
}
export async function createInvite(p: Principal, input: unknown, origin: string) {
	requireAdmin(p);
	const data = z
		.object({ email: z.email().optional(), role: roleSchema, groupIds: z.array(text).max(100) })
		.parse(input);
	const token = secret();
	const now = new Date().toISOString();
	const expiresAt = new Date(Date.now() + 7 * 86400_000).toISOString();
	const inviteId = id("inv");
	for (const group of data.groupIds)
		if (!(await organizationQuery(statement("SELECT id FROM groups WHERE id = ?", [group], "get"))))
			throw new IdentityError(400, "unknown_group");
	await organizationWrite([
		statement(
			"INSERT INTO user_invites (id,token_hash,email,role,group_ids_json,created_by,created_at,expires_at) VALUES (?,?,?,?,?,?,?,?)",
			[inviteId, digest(token), data.email ?? null, data.role, JSON.stringify(data.groupIds), p.userId, now, expiresAt],
		),
		auditStatement(p, "invite.created", "invite", inviteId),
	]);
	const org = await readOrganization();
	return { inviteUrl: `${org.public_url ?? origin}/auth/invite/${token}`, expiresAt };
}
export interface InviteRow {
	id: string;
	email: string | null;
	role: UserRow["role"];
	group_ids_json: string;
	expires_at: string;
	used_at: string | null;
}
export async function readInvite(token: string): Promise<InviteRow> {
	const row = await organizationQuery<InviteRow | null>(
		statement(
			"SELECT id,email,role,group_ids_json,expires_at,used_at FROM user_invites WHERE token_hash = ?",
			[digest(token)],
			"get",
		),
	);
	if (!row || row.used_at || row.expires_at <= new Date().toISOString()) throw new IdentityError(404, "not_found");
	return row;
}
const invitationContinuations = new Map<string, { readonly token: string; readonly expiresAt: number }>();
function invitationContinuation(token: string): string {
	const now = Date.now();
	for (const [key, entry] of invitationContinuations) if (entry.expiresAt <= now) invitationContinuations.delete(key);
	if (invitationContinuations.size >= 1000) throw new IdentityError(429, "rate_limit");
	const code = secret();
	invitationContinuations.set(digest(code), { token, expiresAt: now + 60_000 });
	return `/api/auth/sso/start?continuation=${encodeURIComponent(code)}`;
}
export async function consumeInvitationContinuation(code: string): Promise<string> {
	const key = digest(z.string().min(1).max(256).parse(code));
	const entry = invitationContinuations.get(key);
	invitationContinuations.delete(key);
	if (!entry || entry.expiresAt <= Date.now()) throw new IdentityError(401, "invalid_credential");
	await readInvite(entry.token);
	return entry.token;
}

export async function acceptInvite(input: unknown) {
	const data = z
		.object({
			token: z.string().max(256),
			username: text,
			displayName: text,
			password: z.string().min(1).max(1024).optional(),
		})
		.parse(input);
	const invite = await readInvite(data.token);
	const org = await readOrganization();
	if (org.require_sso || !data.password) return { ssoStartPath: invitationContinuation(data.token) };
	const userId = id("usr"),
		agentId = `personal-${userId.slice(4)}`,
		now = new Date().toISOString();
	const groups = z.array(z.string()).parse(JSON.parse(invite.group_ids_json));
	const session = sessionMaterial(userId, "browser", null, org);
	await organizationWrite([
		{
			...statement(
				"UPDATE user_invites SET used_at = ?,used_by = ? WHERE id = ? AND used_at IS NULL AND expires_at > ?",
				[now, userId, invite.id, now],
			),
			requireChanges: true,
		},
		statement(
			"INSERT INTO users (id,username,email,display_name,role,password_hash,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)",
			[userId, data.username, invite.email, data.displayName, invite.role, await passwordHash(data.password), now, now],
		),
		...(org.agent_model === "personal" ? personalAgentStatements(userId, agentId, data.displayName) : []),
		...groups.map((g) =>
			statement("INSERT INTO group_members (group_id,user_id,role,created_at) VALUES (?,?,'member',?)", [
				g,
				userId,
				now,
			]),
		),
		...session.statements,
		auditStatement(null, "invite.accepted", "invite", invite.id, { userId }),
	]);
	const user = await readUser(userId);
	if (!user) throw new Error("Invite user missing after commit");
	const { statements: _statements, ...result } = session;
	return { ...result, user: userView(user) };
}
export async function groupOwner(p: Principal, groupId: string): Promise<boolean> {
	return Boolean(
		await organizationQuery(
			statement(
				"SELECT 1 FROM group_members WHERE group_id = ? AND user_id = ? AND role = 'owner'",
				[groupId, p.userId],
				"get",
			),
		),
	);
}
export async function listUsers(p: Principal, filters: Record<string, string | undefined>) {
	requireAdmin(p);
	return {
		users: await organizationQuery(
			statement(
				"SELECT id,username,email,display_name,role,compliance,status,personal_agent_id,default_read_agent_id,created_at,updated_at,deactivated_at,last_active_at FROM users WHERE (? IS NULL OR status = ?) AND (? IS NULL OR role = ?) AND (? IS NULL OR id IN (SELECT user_id FROM group_members WHERE group_id = ?)) AND (? IS NULL OR username LIKE ? OR display_name LIKE ?) ORDER BY username LIMIT 1000",
				[
					filters.status ?? null,
					filters.status ?? null,
					filters.role ?? null,
					filters.role ?? null,
					filters.group ?? null,
					filters.group ?? null,
					filters.q ?? null,
					`%${filters.q ?? ""}%`,
					`%${filters.q ?? ""}%`,
				],
				"all",
			),
		),
	};
}
export async function connectorErrors(p: Principal, keyId: string) {
	const identity = requireUser(p);
	if (p.credential.kind !== "session" || p.sourceKeyId)
		throw new IdentityError(403, "permission", "Requires a signed-in user session");
	const key = await readBoundKey(keyId);
	if (!key || key.kind !== "connector" || key.user_id !== identity.userId) throw new IdentityError(403, "not_owner");
	const since = new Date(Date.now() - 7 * 86400_000).toISOString();
	const { connectorErrorHistory } = await import("./organization-store");
	const errors = await connectorErrorHistory({ keyId });
	return { keyId, since, limit: 10, errors };
}

export async function updateUser(p: Principal, userId: string, input: unknown) {
	requireAdmin(p);
	const data = z
		.object({
			role: roleSchema.optional(),
			compliance: z.boolean().optional(),
			displayName: text.optional(),
			email: z.email().max(320).nullable().optional(),
		})
		.parse(input);
	if (!(await readUser(userId))) throw new IdentityError(404, "not_found");
	if (userId === p.userId && data.role && data.role !== "admin")
		throw new IdentityError(403, "org_policy", "Cannot demote your own administrator account");
	await organizationWrite([
		statement(
			"UPDATE users SET role = COALESCE(?,role),compliance = COALESCE(?,compliance),display_name = COALESCE(?,display_name),email = CASE WHEN ? THEN ? ELSE email END,updated_at = ? WHERE id = ?",
			[
				data.role ?? null,
				data.compliance === undefined ? null : Number(data.compliance),
				data.displayName ?? null,
				Number(data.email !== undefined),
				data.email ?? null,
				new Date().toISOString(),
				userId,
			],
		),
		auditStatement(p, "user.updated", "user", userId),
	]);
	return { user: await readUser(userId).then((u) => (u ? userView(u) : null)) };
}
export async function reactivate(p: Principal, userId: string) {
	requireAdmin(p);
	const user = await readUser(userId);
	if (!user) throw new IdentityError(404, "not_found");
	const org = await readOrganization();
	const existing = user.personal_agent_id
		? await organizationQuery<{ owner_user_id: string; archived_at: string | null } | null>(
				statement("SELECT owner_user_id,archived_at FROM agents WHERE id=?", [user.personal_agent_id], "get"),
			)
		: null;
	const writes: DbOwnerStatement[] = [];
	if (org.agent_model === "personal" && (!existing || existing.owner_user_id !== userId || existing.archived_at)) {
		const agentId = `personal-${crypto.randomUUID().replaceAll("-", "")}`;
		writes.push(
			...personalAgentStatements(userId, agentId, user.display_name),
			statement(
				"UPDATE users SET default_read_agent_id=CASE WHEN default_read_agent_id=? THEN ? ELSE default_read_agent_id END WHERE id=?",
				[user.personal_agent_id, agentId, userId],
			),
			auditStatement(p, "agent.personal_created", "agent", agentId),
		);
	}
	writes.push(
		statement("UPDATE users SET status='active',deactivated_at=NULL,updated_at=? WHERE id=?", [
			new Date().toISOString(),
			userId,
		]),
		auditStatement(p, "user.reactivated", "user", userId),
	);
	await organizationWrite(writes);
	return { ok: true };
}
