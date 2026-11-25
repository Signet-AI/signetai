import { z } from "zod";
import type { Principal } from "./principal";
import { rolePermissions } from "./principal";
import { canActAs, type AgentRecord } from "./agent-access";
import {
	auditStatement,
	id,
	IdentityError,
	organizationQuery,
	organizationWrite,
	readOrganization,
	readUser,
	statement,
	userPrincipal,
	userView,
} from "./organization-store";
import { groupOwner, requireAdmin, requireAudit } from "./organization-operations";
import type { DbOwnerStatement } from "../db-owner-protocol";
import { readableClassificationsFor } from "../classification-access";

const text = z.string().trim().min(1).max(128);
export async function invites(p: Principal) {
	requireAdmin(p);
	return {
		invites: await organizationQuery(
			statement(
				"SELECT id,email,role,group_ids_json,created_by,created_at,expires_at,used_at,used_by FROM user_invites ORDER BY created_at DESC LIMIT 1000",
				[],
				"all",
			),
		),
	};
}
export async function deleteInvite(p: Principal, inviteId: string) {
	requireAdmin(p);
	await organizationWrite([
		statement("DELETE FROM user_invites WHERE id = ?", [inviteId]),
		auditStatement(p, "invite.deleted", "invite", inviteId),
	]);
	return { ok: true };
}
interface GroupRow {
	id: string;
	name: string;
	description: string | null;
	managed_by: "signet" | "idp";
}
export async function groups(_p: Principal) {
	return { groups: await organizationQuery(statement("SELECT * FROM groups ORDER BY name LIMIT 1000", [], "all")) };
}
export async function group(_p: Principal, groupId: string) {
	const row = await organizationQuery<GroupRow | null>(
		statement("SELECT * FROM groups WHERE id = ?", [groupId], "get"),
	);
	if (!row) throw new IdentityError(404, "not_found");
	return {
		...row,
		members: await organizationQuery(
			statement(
				"SELECT u.id,u.username,u.display_name,m.role,m.managed_by FROM group_members m JOIN users u ON u.id = m.user_id WHERE m.group_id = ? ORDER BY u.username LIMIT 1000",
				[groupId],
				"all",
			),
		),
	};
}
export async function createGroup(p: Principal, input: unknown) {
	requireAdmin(p);
	const data = z.object({ name: text, description: z.string().max(2048).optional() }).parse(input);
	const groupId = id("grp"),
		now = new Date().toISOString();
	await organizationWrite([
		statement("INSERT INTO groups (id,name,description,created_at,updated_at) VALUES (?,?,?,?,?)", [
			groupId,
			data.name,
			data.description ?? null,
			now,
			now,
		]),
		auditStatement(p, "group.created", "group", groupId),
	]);
	return group(p, groupId);
}
export async function changeGroup(p: Principal, groupId: string, input: unknown | null) {
	requireAdmin(p);
	const row = await group(p, groupId);
	if (row.managed_by === "idp") throw new IdentityError(409, "managed_by_idp");
	let writes: DbOwnerStatement[];
	if (input === null)
		writes = [
			statement("DELETE FROM group_members WHERE group_id = ?", [groupId]),
			statement("DELETE FROM groups WHERE id = ?", [groupId]),
		];
	else {
		const data = z.object({ name: text.optional(), description: z.string().max(2048).optional() }).parse(input);
		writes = [
			statement(
				"UPDATE groups SET name = COALESCE(?,name),description = COALESCE(?,description),updated_at = ? WHERE id = ?",
				[data.name ?? null, data.description ?? null, new Date().toISOString(), groupId],
			),
		];
	}
	await organizationWrite([
		...writes,
		auditStatement(p, input === null ? "group.deleted" : "group.updated", "group", groupId),
	]);
	return { ok: true };
}
export async function groupMember(p: Principal, groupId: string, userId: string, input: unknown | null) {
	const row = await group(p, groupId);
	if (row.managed_by === "idp") throw new IdentityError(409, "managed_by_idp");
	if (p.role !== "admin" && !(await groupOwner(p, groupId))) throw new IdentityError(403, "not_owner");
	if (!(await readUser(userId))) throw new IdentityError(404, "not_found");
	const writes =
		input === null
			? [statement("DELETE FROM group_members WHERE group_id = ? AND user_id = ?", [groupId, userId])]
			: [
					statement(
						"INSERT INTO group_members (group_id,user_id,role,created_at) VALUES (?,?,?,?) ON CONFLICT(group_id,user_id) DO UPDATE SET role = excluded.role",
						[
							groupId,
							userId,
							z.object({ role: z.enum(["owner", "member"]) }).parse(input).role,
							new Date().toISOString(),
						],
					),
				];
	await organizationWrite([...writes, auditStatement(p, "group.membership_updated", "group", groupId, { userId })]);
	return { ok: true };
}
interface NamedAgent extends AgentRecord {
	name: string;
}
export async function agents(p: Principal) {
	const rows = await organizationQuery<NamedAgent[]>(
		statement("SELECT * FROM agents ORDER BY name LIMIT 1000", [], "all"),
	);
	return {
		agents: rows.map((a) => ({
			id: a.id,
			name: a.name,
			kind: a.kind,
			ownerUserId: a.owner_user_id,
			ownerGroupId: a.owner_group_id,
			archivedAt: a.archived_at,
			canActAs: canActAs(p, a),
		})),
	};
}
export async function createAgent(p: Principal, input: unknown) {
	const data = z.object({ name: text, kind: z.enum(["personal", "team"]), ownerGroupId: text.optional() }).parse(input);
	const org = await readOrganization();
	if (data.kind === "personal" && !org.personal_agents_self_service) throw new IdentityError(403, "org_policy");
	if (data.kind === "team" && (!data.ownerGroupId || (p.role !== "admin" && !(await groupOwner(p, data.ownerGroupId)))))
		throw new IdentityError(403, "not_owner");
	if (data.ownerGroupId) await group(p, data.ownerGroupId);
	const agentId = `agent-${crypto.randomUUID().replaceAll("-", "")}`,
		now = new Date().toISOString();
	await organizationWrite([
		statement(
			"INSERT INTO agents (id,name,kind,read_policy,owner_user_id,owner_group_id,created_at,updated_at) VALUES (?,?,?,'isolated',?,?,?,?)",
			[agentId, data.name, data.kind, data.kind === "personal" ? p.userId : null, data.ownerGroupId ?? null, now, now],
		),
		auditStatement(p, "agent.created", "agent", agentId),
	]);
	return { agentId };
}
export async function updateAgent(p: Principal, agentId: string, input: unknown) {
	requireAdmin(p);
	const data = z
		.object({
			name: text.optional(),
			ownerUserId: text.optional(),
			ownerGroupId: text.optional(),
			archived: z.boolean().optional(),
		})
		.parse(input);
	if (agentId === "default" && data.archived) throw new IdentityError(403, "org_policy");
	if (data.ownerUserId && !(await readUser(data.ownerUserId))) throw new IdentityError(404, "not_found");
	if (data.ownerGroupId) await group(p, data.ownerGroupId);
	await organizationWrite([
		{
			...statement(
				"UPDATE agents SET name = COALESCE(?,name),owner_user_id = COALESCE(?,owner_user_id),owner_group_id = COALESCE(?,owner_group_id),archived_at = CASE WHEN ? IS NULL THEN archived_at WHEN ? = 1 THEN ? ELSE NULL END,updated_at = ? WHERE id = ?",
				[
					data.name ?? null,
					data.ownerUserId ?? null,
					data.ownerGroupId ?? null,
					data.archived === undefined ? null : Number(data.archived),
					data.archived === undefined ? null : Number(data.archived),
					new Date().toISOString(),
					new Date().toISOString(),
					agentId,
				],
			),
			requireChanges: true,
		},
		auditStatement(p, "agent.updated", "agent", agentId),
	]);
	return { ok: true };
}
export async function legacyAgents(p: Principal) {
	requireAdmin(p);
	return {
		agents: await organizationQuery(
			statement("SELECT id,name FROM agents WHERE kind = 'legacy' ORDER BY name LIMIT 1000", [], "all"),
		),
	};
}
export async function mapAgent(p: Principal, agentId: string, input: unknown) {
	requireAdmin(p);
	const data = z
		.object({
			kind: z.enum(["personal", "team", "organization"]),
			ownerUserId: text.optional(),
			ownerGroupId: text.optional(),
		})
		.parse(input);
	if (data.kind === "personal" && (!data.ownerUserId || !(await readUser(data.ownerUserId))))
		throw new IdentityError(400, "owner_required");
	if (data.kind === "team") {
		if (!data.ownerGroupId) throw new IdentityError(400, "owner_required");
		await group(p, data.ownerGroupId);
	}
	if (data.kind === "organization" && agentId !== "default") throw new IdentityError(403, "org_policy");
	await organizationWrite([
		{
			...statement("UPDATE agents SET kind = ?,owner_user_id = ?,owner_group_id = ?,updated_at = ? WHERE id = ?", [
				data.kind,
				data.ownerUserId ?? null,
				data.ownerGroupId ?? null,
				new Date().toISOString(),
				agentId,
			]),
			requireChanges: true,
		},
		auditStatement(p, "agent.mapped", "agent", agentId),
	]);
	return { ok: true };
}
export async function effectiveAccess(p: Principal, userId: string) {
	if (p.role !== "admin" && !p.compliance) throw new IdentityError(403, "permission");
	const u = await readUser(userId);
	if (!u) throw new IdentityError(404, "not_found");
	const target = await userPrincipal(u, { kind: "session", id: "access-inspector" }, null, null);
	const rows = await organizationQuery<AgentRecord[]>(
		statement("SELECT * FROM agents WHERE archived_at IS NULL", [], "all"),
	);
	return {
		user: userView(u),
		role: u.role,
		permissions: [...rolePermissions(u.role, Boolean(u.compliance))],
		groups: target.groupIds,
		actAs:
			u.status !== "active"
				? []
				: rows
						.filter((a) => canActAs(target, a))
						.map((a) => ({
							agentId: a.id,
							kind: a.kind,
							why:
								a.kind === "organization"
									? "active user"
									: a.kind === "personal"
										? "personal owner"
										: a.kind === "team"
											? "group membership"
											: "administrator",
						})),
		readableClassifications: await readableClassificationsFor(userId),
	};
}
const oidcSchema = z
	.object({
		issuer: z.url(),
		clientId: text,
		clientSecretRef: text.optional(),
		scopes: z.array(text).max(20).optional(),
		groupClaim: text.optional(),
		groupMap: z.record(z.string(), text).optional(),
		allowedDomains: z.array(text).max(100).default([]),
	})
	.strict();
const settingsSchema = z
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
		publicUrl: z.url().optional(),
		oidc: oidcSchema.nullable().optional(),
	})
	.strict();
const settingsColumns = {
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
export async function settings(p: Principal) {
	requireAdmin(p);
	const org = await readOrganization();
	return {
		name: org.name,
		agentModel: org.agent_model,
		personalAgentsSelfService: Boolean(org.personal_agents_self_service),
		passwordLogin: Boolean(org.password_login),
		requireSso: Boolean(org.require_sso),
		sessionTtlSeconds: org.session_ttl_seconds,
		refreshTtlSeconds: org.refresh_ttl_seconds,
		accessTtlSeconds: org.access_ttl_seconds,
		connectorKeyTtlSeconds: org.connector_key_ttl_seconds,
		legacyKeyDeadline: org.legacy_key_deadline,
		auditRetentionDays: org.audit_retention_days,
		publicUrl: org.public_url,
		oidc: org.oidc_json ? oidcSchema.parse(JSON.parse(org.oidc_json)) : null,
	};
}
export async function updateSettings(p: Principal, input: unknown) {
	requireAdmin(p);
	const data = settingsSchema.parse(input);
	const current = await readOrganization();
	if (data.requireSso === true && !(data.oidc ?? current.oidc_json))
		throw new IdentityError(403, "org_policy", "Configure SSO before requiring it");
	const writes: DbOwnerStatement[] = [];
	for (const key of Object.keys(settingsColumns)) {
		const value = Reflect.get(data, key);
		if (value === undefined) continue;
		const column = Reflect.get(settingsColumns, key);
		if (typeof column !== "string") throw new Error("Unknown organization setting");
		const normalized =
			key === "oidc"
				? value === null
					? null
					: JSON.stringify(value)
				: typeof value === "boolean"
					? Number(value)
					: value;
		if (typeof normalized !== "string" && typeof normalized !== "number" && normalized !== null)
			throw new IdentityError(400, "invalid_request");
		writes.push(
			statement(`UPDATE organization SET ${column} = ?,updated_at = ? WHERE id = 1`, [
				normalized,
				new Date().toISOString(),
			]),
		);
	}
	await organizationWrite([
		...writes,
		auditStatement(p, "organization.settings_updated", "organization", "1", { fields: Object.keys(data) }),
	]);
	return settings(p);
}
export async function keys(p: Principal, filters: Record<string, string | undefined>) {
	requireAdmin(p);
	const where: string[] = [];
	const params: string[] = [];
	for (const [key, column] of Object.entries({
		userId: "user_id",
		deviceId: "device_id",
		harness: "harness",
		agentId: "agent_id",
		legacy: "legacy",
	})) {
		const value = filters[key];
		if (value !== undefined) {
			where.push(`${column} = ?`);
			params.push(value);
		}
	}
	return {
		keys: await organizationQuery(
			statement(
				`SELECT id,prefix,name,user_id,device_id,harness,agent_id,kind,legacy,created_at,last_used_at,expires_at,revoked_at FROM api_keys WHERE ${where.join(" AND ") || "1=1"} ORDER BY created_at DESC LIMIT 1000`,
				params,
				"all",
			),
		),
	};
}
export async function assignKey(p: Principal, keyId: string, input: unknown) {
	requireAdmin(p);
	const data = z.object({ userId: text }).parse(input);
	await activeTarget(data.userId);
	await organizationWrite([
		{
			...statement("UPDATE api_keys SET user_id = ?,legacy = 0 WHERE id = ? AND kind = 'legacy'", [data.userId, keyId]),
			requireChanges: true,
		},
		auditStatement(p, "key.assigned", "key", keyId, { userId: data.userId }),
	]);
	return { ok: true };
}
async function activeTarget(userId: string) {
	const u = await readUser(userId);
	if (!u || u.status !== "active") throw new IdentityError(400, "invalid_user");
	return u;
}
export async function bulkRevoke(p: Principal, input: unknown) {
	requireAdmin(p);
	const data = z.object({ ids: z.array(text).min(1).max(1000) }).parse(input);
	const jobId = id("job"),
		now = new Date().toISOString();
	await organizationWrite([
		statement(
			"INSERT INTO org_jobs (id,kind,status,params_json,progress_json,created_by,created_at,started_at,finished_at) VALUES (?,'bulk_revoke','complete',?,?,?,?,?,?)",
			[jobId, JSON.stringify({ ids: data.ids }), JSON.stringify({ revoked: data.ids.length }), p.userId, now, now, now],
		),
		...data.ids.map((keyId) => statement("UPDATE api_keys SET revoked_at = ? WHERE id = ?", [now, keyId])),
		auditStatement(p, "key.bulk_revoked", "job", jobId, { ids: data.ids }),
	]);
	return { jobId };
}
export async function jobs(p: Principal, kind?: string) {
	requireAdmin(p);
	return {
		jobs: await organizationQuery(
			statement(
				"SELECT * FROM org_jobs WHERE (? IS NULL OR kind = ?) ORDER BY created_at DESC LIMIT 1000",
				[kind ?? null, kind ?? null],
				"all",
			),
		),
	};
}
export async function job(p: Principal, jobId: string) {
	const result = await organizationQuery<{ created_by: string } | null>(
		statement("SELECT * FROM org_jobs WHERE id = ?", [jobId], "get"),
	);
	if (!result) throw new IdentityError(404, "not_found");
	if (result.created_by !== p.userId) requireAdmin(p);
	return result;
}
export async function audit(p: Principal, filters: Record<string, string | undefined>) {
	requireAudit(p);
	const limit = z.coerce
		.number()
		.int()
		.min(1)
		.max(1000)
		.parse(filters.limit ?? 100);
	const predicates: string[] = [];
	const params: (string | number)[] = [];
	for (const [key, column] of Object.entries({
		actor: "actor_user_id",
		action: "action",
		targetKind: "target_kind",
		targetId: "target_id",
	})) {
		const value = filters[key];
		if (value) {
			predicates.push(`${column} = ?`);
			params.push(value);
		}
	}
	if (filters.since) {
		predicates.push("at >= ?");
		params.push(z.iso.datetime().parse(filters.since));
	}
	if (filters.until) {
		predicates.push("at <= ?");
		params.push(z.iso.datetime().parse(filters.until));
	}
	if (filters.cursor) {
		const cursor = z
			.tuple([z.string(), z.string()])
			.parse(JSON.parse(Buffer.from(filters.cursor, "base64url").toString()));
		predicates.push("(at,id) < (?,?)");
		params.push(...cursor);
	}
	const rows = await organizationQuery<Record<string, unknown>[]>(
		statement(
			`SELECT * FROM audit_events WHERE ${predicates.join(" AND ") || "1=1"} ORDER BY at DESC,id DESC LIMIT ?`,
			[...params, limit + 1],
			"all",
		),
	);
	const events = rows.slice(0, limit);
	const last = events.at(-1);
	return {
		events,
		nextCursor:
			rows.length > limit && last ? Buffer.from(JSON.stringify([last.at, last.id])).toString("base64url") : null,
	};
}
export async function auditExport(p: Principal, filters: Record<string, string | undefined>) {
	requireAudit(p);
	const lines: string[] = [];
	let cursor = filters.cursor;
	do {
		const page = await audit(p, { ...filters, limit: "1000", cursor });
		lines.push(...page.events.map((row) => JSON.stringify(row)));
		cursor = page.nextCursor ?? undefined;
		if (lines.length >= 100_000 && cursor)
			throw new IdentityError(400, "export_limit", "Narrow the audit export time range");
	} while (cursor);
	return `${lines.join("\n")}\n`;
}
export async function deactivate(p: Principal, userId: string, input: unknown, basePath: string) {
	requireAdmin(p);
	if (userId === p.userId) throw new IdentityError(403, "org_policy", "Cannot deactivate yourself");
	const data = z
		.object({
			mode: z.enum(["keep", "transfer", "purge"]),
			transferTo: text.optional(),
			dryRun: z.boolean().default(true),
		})
		.parse(input);
	if (!(await readUser(userId))) throw new IdentityError(404, "not_found");
	if (data.mode === "transfer") {
		if (!data.transferTo || data.transferTo === userId) throw new IdentityError(400, "invalid_transfer");
		await activeTarget(data.transferTo);
	}
	const counts = await organizationQuery<Record<string, number>>(
		statement(
			"SELECT (SELECT COUNT(*) FROM memories WHERE author_user_id = ?) AS memories,(SELECT COUNT(*) FROM session_transcripts WHERE speaker_user_id = ?) AS transcripts,(SELECT COUNT(*) FROM memory_artifacts WHERE author_user_id = ?) AS artifacts,(SELECT COUNT(*) FROM documents WHERE author_user_id = ?) AS documents,(SELECT COUNT(*) FROM api_keys WHERE user_id = ? AND revoked_at IS NULL) AS keys,(SELECT COUNT(*) FROM auth_sessions WHERE user_id = ? AND revoked_at IS NULL) AS sessions",
			[userId, userId, userId, userId, userId, userId],
			"get",
		),
	);
	const plan = { userId, mode: data.mode, transferTo: data.transferTo ?? null, counts };
	if (data.dryRun) return { plan };
	const jobId = id("job"),
		now = new Date().toISOString();
	const writes = [
		statement(
			"INSERT INTO org_jobs (id,kind,status,params_json,created_by,created_at,started_at) VALUES (?,'offboard','running',?,?,?,?)",
			[jobId, JSON.stringify(plan), p.userId, now, now],
		),
		statement("UPDATE users SET status = 'deactivated',deactivated_at = ?,updated_at = ? WHERE id = ?", [
			now,
			now,
			userId,
		]),
		statement("UPDATE auth_sessions SET revoked_at = ?,revoked_reason = 'user_deactivated' WHERE user_id = ?", [
			now,
			userId,
		]),
		statement("UPDATE api_keys SET revoked_at = ? WHERE user_id = ?", [now, userId]),
		auditStatement(p, "user.deactivated", "user", userId, plan),
	];
	if (data.mode === "transfer") {
		writes.push(
			statement("UPDATE agents SET owner_user_id = ? WHERE owner_user_id = ?", [data.transferTo ?? null, userId]),
		);
	}
	if (data.mode !== "purge")
		writes.push(
			statement("UPDATE org_jobs SET status = 'complete',progress_json = ?,finished_at = ? WHERE id = ?", [
				JSON.stringify({ mode: data.mode, counts }),
				now,
				jobId,
			]),
		);
	await organizationWrite(writes);
	if (data.mode === "purge") {
		const { runOffboardPurge } = await import("./organization-purge");
		void runOffboardPurge(p, jobId, userId, basePath).catch(async (error: unknown) => {
			await organizationWrite([
				statement("UPDATE org_jobs SET status = 'failed',error = ?,finished_at = ? WHERE id = ?", [
					error instanceof Error ? error.message : String(error),
					new Date().toISOString(),
					jobId,
				]),
			]);
		});
	}
	return { jobId };
}
