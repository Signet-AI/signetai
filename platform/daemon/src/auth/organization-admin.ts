import { oidcSchema, settingsSchema } from "./organization-settings-contract";
import { operatorActor, operatorRequest } from "../operator-jobs";
import { attemptAsync } from "@signet/core";
import { z } from "zod";
import { readableClassificationsFor } from "../classification-access";
import { audienceSubjectFromPrincipal, inFlightClassificationSql, resolveReadScope } from "../read-scope";
import { dbOwnerOrganizationPurgePlan } from "../db-owner-runtime";
import type { DbOwnerStatement } from "../db-owner-protocol";
import { logger } from "../logger";
import { type AgentRecord, canActAs } from "./agent-access";
import { groupOwner, requireAdmin, requireAudit, whoami } from "./organization-operations";
import {
	auditStatement,
	IdentityError,
	id,
	organizationQuery,
	organizationWrite,
	readOrganization,
	readUser,
	statement,
	userPrincipal,
	userView,
} from "./organization-store";
import type { Principal } from "./principal";
import { rolePermissions } from "./principal";

const text = z.string().trim().min(1).max(128);
export async function lookupUsers(p: Principal, input: unknown) {
	if (!(p.permissions.has("admin") || (p.compliance && p.permissions.has("classify"))))
		throw new IdentityError(403, "permission", "Requires admin or compliance access");
	if (p.boundAgentId !== null) throw new IdentityError(403, "agent_not_permitted");
	if (p.allowedProjects !== null) throw new IdentityError(403, "project_not_permitted");
	const data = z
		.object({ q: text, limit: z.coerce.number().int().min(1).max(50).default(20), cursor: text.optional() })
		.strict()
		.parse(input);
	const pattern = `%${data.q.replaceAll("\\", "\\\\").replaceAll("%", "\\%").replaceAll("_", "\\_")}%`;
	const rows = await organizationQuery<readonly { id: string; displayName: string; email: string | null }[]>(
		statement(
			"SELECT id,display_name AS displayName,email FROM users WHERE status='active' AND (? IS NULL OR id>?) AND (display_name LIKE ? ESCAPE '\\' OR email LIKE ? ESCAPE '\\') ORDER BY id LIMIT ?",
			[data.cursor ?? null, data.cursor ?? null, pattern, pattern, data.limit + 1],
			"all",
		),
	);
	const users = rows.slice(0, data.limit);
	await organizationWrite([auditStatement(p, "user.lookup", "user", null, { count: users.length })]);
	return { users, nextCursor: rows.length > data.limit ? (users.at(-1)?.id ?? null) : null };
}
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
	if (p.role !== "admin" && !(await groupOwner(p, groupId)))
		throw new IdentityError(
			403,
			"not_owner",
			`Ask a team owner (${Array.from(row.name, (character) => (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127 ? " " : character)).join("")})`,
		);
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
	const data = z
		.object({
			name: text.optional(),
			ownerUserId: text.optional(),
			ownerGroupId: text.optional(),
			archived: z.boolean().optional(),
		})
		.strict()
		.parse(input);
	if (p.boundAgentId && p.boundAgentId !== agentId) throw new IdentityError(403, "agent_binding_conflict");
	if (p.role === "admin") requireAdmin(p);
	else {
		const owned = await organizationQuery<AgentRecord | null>(
			statement("SELECT id,kind,owner_user_id,owner_group_id,archived_at FROM agents WHERE id=?", [agentId], "get"),
		);
		if (
			!p.permissions.has("modify") ||
			!data.name ||
			Object.keys(data).some((key) => key !== "name") ||
			owned?.kind !== "personal" ||
			owned.owner_user_id !== p.userId ||
			owned.archived_at
		)
			throw new IdentityError(403, "not_owner", "Only the owner can rename a personal agent");
	}
	if (data.ownerUserId && data.ownerGroupId) throw new IdentityError(400, "invalid_transfer");
	if (agentId === "default" && (data.archived || data.ownerUserId || data.ownerGroupId))
		throw new IdentityError(403, "org_policy");
	if (data.ownerUserId) await activeTarget(data.ownerUserId);
	if (data.ownerGroupId) await group(p, data.ownerGroupId);
	const transfer =
		data.ownerUserId || data.ownerGroupId
			? [
					statement("UPDATE agents SET kind=?,owner_user_id=?,owner_group_id=? WHERE id=?", [
						data.ownerUserId ? "personal" : "team",
						data.ownerUserId ?? null,
						data.ownerGroupId ?? null,
						agentId,
					]),
				]
			: [];
	await organizationWrite([
		...transfer,
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
	await operatorRequest({ op: "settings", actor: operatorActor(p), input: data });
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
export async function settleOffboardPurge(work: Promise<void>, jobId: string): Promise<void> {
	const [result] = await Promise.allSettled([work]);
	if (result?.status !== "rejected") return;
	const [recorded] = await Promise.allSettled([
		organizationWrite([
			{
				...statement("UPDATE org_jobs SET status='failed',error=?,finished_at=? WHERE id=?", [
					result.reason instanceof Error ? result.reason.message : String(result.reason),
					new Date().toISOString(),
					jobId,
				]),
				requireChanges: true,
			},
		]),
	]);
	if (recorded?.status === "rejected")
		logger.error(
			"auth",
			"Offboarding failure could not be persisted",
			recorded.reason instanceof Error ? recorded.reason : undefined,
			{ jobId },
		);
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
export async function auditOrgExport(p: Principal, author: string | null, all: boolean) {
	await organizationWrite([auditStatement(p, "organization.export", "user", author, { all })]);
}
export async function organizationDoctor(
	p: Principal,
	org: import("./organization-store").OrganizationRow,
	proxy: boolean,
) {
	if (!p.permissions.has("diagnostics")) throw new IdentityError(403, "permission", "Requires diagnostics permission");
	const database = await attemptAsync(() =>
		organizationQuery<{ available: number }>(statement("SELECT 1 AS available", [], "get")),
	);
	const identity = await whoami(p, org, proxy);
	await organizationWrite([auditStatement(p, "operator.doctor", "instance", null)]);
	return {
		identity,
		serverTime: new Date().toISOString(),
		diagnostics: { database: database?.available === 1 ? "ready" : "unavailable", content: "unavailable" },
		status: database?.available === 1 ? "healthy" : "degraded",
	};
}
export async function beginSupervisedRestart(p: Principal, supervisor: string) {
	requireAdmin(p);
	const jobId = id("job"),
		now = new Date().toISOString();
	await organizationWrite([
		statement(
			"INSERT INTO org_jobs(id,kind,status,params_json,created_by,created_at) VALUES(?,'restart','pending',?,?,?)",
			[jobId, JSON.stringify({ supervisor, originPid: process.pid }), p.userId, now],
		),
		auditStatement(p, "operator.restart_requested", "job", jobId),
	]);
	return jobId;
}
export async function settleSupervisedRestart(jobId: string, status: "running" | "incomplete", p: Principal) {
	await organizationWrite([
		statement(
			"UPDATE org_jobs SET status=?,error=?,started_at=coalesce(started_at,?) WHERE id=? AND kind='restart' AND status IN ('pending','running')",
			[status, status === "incomplete" ? "restart_unconfirmed" : null, new Date().toISOString(), jobId],
		),
		auditStatement(p, `operator.restart_${status}`, "job", jobId),
	]);
}
export async function completeSupervisedRestart(supervisor: string) {
	const rows = await organizationQuery<readonly { id: string }[]>(
		statement(
			"SELECT id FROM org_jobs WHERE kind='restart' AND status IN ('pending','running','incomplete') AND json_extract(params_json,'$.supervisor')=? AND json_extract(params_json,'$.originPid')<>? ORDER BY created_at LIMIT 100",
			[supervisor, process.pid],
			"all",
		),
	);
	for (const row of rows)
		await organizationWrite([
			statement("UPDATE org_jobs SET status='complete',error=NULL,finished_at=? WHERE id=?", [
				new Date().toISOString(),
				row.id,
			]),
			statement(
				"INSERT INTO audit_events(id,at,actor_credential,action,target_kind,target_id,outcome) VALUES(?,?,'system','operator.restart_completed','job',?,'ok')",
				[id("aud"), new Date().toISOString(), row.id],
			),
		]);
}

export async function jobs(p: Principal, kind?: string) {
	requireAdmin(p);
	return {
		jobs: [
			...(
				await operatorRequest<readonly import("../operator-job-contract").OperatorJobRow[]>({
					op: "list",
					actor: operatorActor(p),
				})
			).filter(() => !kind || kind === "operator"),
			...(await organizationQuery<readonly import("../operator-job-contract").OperatorJobRow[]>(
				statement(
					"SELECT * FROM org_jobs WHERE kind<>'operator' AND (kind NOT IN ('restart','agent_purge') OR (? IS NULL AND ? IS NULL)) AND (? IS NULL OR kind = ?) ORDER BY created_at DESC LIMIT 1000",
					[p.boundAgentId, p.allowedProjects === null ? null : "restricted", kind ?? null, kind ?? null],
					"all",
				),
			)),
		]
			.sort((a, b) => b.created_at.localeCompare(a.created_at))
			.slice(0, 1000),
	};
}
export async function job(p: Principal, jobId: string) {
	const result = await organizationQuery<{ created_by: string; kind: string } | null>(
		statement("SELECT * FROM org_jobs WHERE id = ?", [jobId], "get"),
	);
	if (!result) throw new IdentityError(404, "not_found");
	if (["restart", "agent_purge"].includes(result.kind) && (p.boundAgentId !== null || p.allowedProjects !== null))
		throw new IdentityError(404, "not_found");
	if (result.kind === "agent_purge")
		return operatorRequest({ op: "agent-purge", stage: "read", actor: operatorActor(p), jobId, runtimeId: "" });
	if (result.kind === "operator") return operatorRequest({ op: "get", actor: operatorActor(p), jobId });
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
	let transferTarget: { userId: string; displayName: string } | null = null;
	if (data.mode === "transfer") {
		if (!data.transferTo || data.transferTo === userId) throw new IdentityError(400, "invalid_transfer");
		const recipient = await activeTarget(data.transferTo);
		transferTarget = { userId: recipient.id, displayName: recipient.display_name };
	}
	const scope = await resolveReadScope(
		{ reach: p.boundAgentId ? { kind: "own", agentId: p.boundAgentId } : { kind: "all" }, projects: p.allowedProjects },
		audienceSubjectFromPrincipal(p),
	);
	let impact: Record<string, number>;
	try {
		impact = await dbOwnerOrganizationPurgePlan(userId, scope);
	} catch (error) {
		if (error instanceof Error && error.message === "plan_limit")
			throw new IdentityError(400, "plan_limit", "Narrow the offboarding preview to an agent");
		throw error;
	}
	const visibleAgents = `WITH visible_agents AS (SELECT a.id,a.name,a.kind,a.owner_user_id FROM agents a WHERE a.archived_at IS NULL${p.boundAgentId ? " AND a.id=?" : ""} AND NOT EXISTS(SELECT 1 FROM classification_assignments ca WHERE ca.target_kind='agent' AND ca.target_id=a.id AND NOT EXISTS(SELECT 1 FROM classification_audience audience WHERE audience.classification_id=ca.classification_id AND ((audience.principal_kind='user' AND audience.principal_id=?) OR (audience.principal_kind='group' AND audience.principal_id IN (SELECT group_id FROM group_members WHERE user_id=?))))) AND NOT EXISTS(SELECT 1 FROM org_jobs j WHERE ${inFlightClassificationSql("j")} AND json_extract(j.params_json,'$.target.kind')='agent' AND json_extract(j.params_json,'$.target.agentId')=a.id))`;
	const agentArgs = [...(p.boundAgentId ? [p.boundAgentId] : []), p.userId, p.userId, p.userId, p.userId];
	const at = new Date().toISOString();
	const counts = await organizationQuery<Record<string, number>>(
		statement(
			`${visibleAgents} SELECT (SELECT COUNT(*) FROM api_keys k WHERE k.user_id=? AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>?) AND (k.agent_id IS NULL OR k.agent_id IN (SELECT id FROM visible_agents))) AS keys,(SELECT COUNT(*) FROM auth_sessions WHERE user_id=? AND revoked_at IS NULL AND (access_expires_at>? OR refresh_expires_at>?)) AS sessions,(SELECT COUNT(*) FROM visible_agents WHERE owner_user_id=?) AS agents`,
			[...agentArgs, userId, at, userId, at, at, userId],
			"get",
		),
	);
	const owned = await organizationQuery<{ id: string; name: string; kind: string }[]>(
		statement(
			`${visibleAgents} SELECT id,name,kind FROM visible_agents WHERE owner_user_id=? ORDER BY id LIMIT 1001`,
			[...agentArgs, userId],
			"all",
		),
	);
	if (owned.length > 1000) throw new IdentityError(400, "plan_limit", "Narrow the offboarding preview to an agent");
	const plan = {
		userId,
		mode: data.mode,
		transferTo: data.transferTo ?? null,
		counts: { ...counts, ...impact },
		ownedAgents: owned.map((agent) => ({ ...agent, transferTo: transferTarget })),
	};
	if (data.dryRun) {
		await organizationWrite([auditStatement(p, "user.offboarding_previewed", "user", userId, plan)]);
		return { plan };
	}
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
		statement(
			"UPDATE auth_sessions SET revoked_at = ?,revoked_reason = 'user_deactivated',refresh_retry_json = '[]' WHERE user_id = ? AND revoked_at IS NULL",
			[now, userId],
		),
		statement("UPDATE api_keys SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL", [now, userId]),
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
		void settleOffboardPurge(runOffboardPurge(p, jobId, userId, basePath), jobId);
	}
	return { jobId };
}
