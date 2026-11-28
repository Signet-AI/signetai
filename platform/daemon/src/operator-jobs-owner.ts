import { settingsSchema, settingsColumns } from "./auth/organization-settings-contract";
import { visibleAgentSql, type OrganizationRow } from "./auth/organization-store";
import { removeAgentInTx } from "./agent-removal";
import { purgeAuthoredMemoryBatchInTx } from "./auth/organization-purge";
import { canActAs, type AgentRecord } from "./auth/agent-access";
import { createHash, randomUUID } from "node:crypto";
import {
	ORGANIZATION_RETAINED_STORE_POLICY,
	upgradePlanSchema,
	upgradePreviewSchema,
	UPGRADE_AGENT_LIMIT,
	UPGRADE_KEY_LIMIT,
	UPGRADE_BATCH_SIZE,
	type UpgradePlanInput,
	type UpgradePreview,
	type UpgradeView,
	type UpgradeRequest,
} from "./organization-upgrade-contract";
import { z } from "zod";
import { prepareTypedStatement, type WriteDb } from "./db-accessor";
import { executeClassification } from "./classification-owner";
import { readVisibilitySchema, readScopeSql, type ReadScope } from "./read-scope";
import { auditAuthoredWriteInTx } from "./auth/audit-owner";
import {
	commitRepairEmbeddingsInTx,
	requeueDeadJobsInTx,
	cancelObsoleteJobsInTx,
	pruneTerminalJobsInTx,
} from "./repair-actions";
import {
	operatorInputSchema,
	type OperatorActor,
	type OperatorRequest,
	type OperatorJobRow,
} from "./operator-job-contract";
import type { UnembeddedRow } from "./embedding-coverage";
import { resolveActiveEmbeddingConfig } from "./embedding-index-state";

const actorSchema = z.object({
	userId: z.string(),
	credentialKind: z.enum(["session", "api_key"]),
	credentialId: z.string(),
	permissions: z.array(z.string()),
	boundAgentId: z.string().nullable(),
	allowedProjects: z.array(z.string()).nullable(),
});
const scopeSchema = z.object({
	reach: z.object({ kind: z.literal("own"), agentId: z.string() }),
	projects: z.array(z.string()).nullable(),
	compartments: z.array(z.number().int().positive()),
	inFlightUserId: z.string().optional(),
});
const planSchema = z.object({
	input: operatorInputSchema,
	actor: actorSchema,
	scope: scopeSchema,
	runtimeId: z.string(),
});
const sessionSchema = z.object({
	user_id: z.string(),
	revoked_at: z.string().nullable(),
	access_expires_at: z.string(),
	device_id: z.string().nullable(),
	source_key_id: z.string().nullable(),
	source_key_ceiling_json: z.string().nullable(),
});
const keySchema = z.object({
	user_id: z.string().nullable(),
	revoked_at: z.string().nullable(),
	expires_at: z.string().nullable(),
	agent_id: z.string().nullable(),
	allowed_projects_json: z.string().nullable(),
	permissions_json: z.string(),
	kind: z.string(),
	device_id: z.string().nullable(),
});
function deny(reason: string): never {
	throw new Error(`operator:${reason}`);
}
function actorScope(
	db: WriteDb,
	actor: OperatorActor,
	original: ReadScope,
	permission: string,
	global = false,
): ReadScope & { readonly groupIds: readonly string[] } {
	const user = z
		.object({ status: z.string(), role: z.string() })
		.parse(db.prepare("SELECT status,role FROM users WHERE id=?").get(actor.userId));
	if (user.status !== "active" || user.role !== "admin" || !actor.permissions.includes(permission)) deny("permission");
	let projects = actor.allowedProjects;
	const intersect = (limit: readonly string[] | null) => {
		if (limit !== null) projects = projects === null ? [...limit] : projects.filter((p) => limit.includes(p));
	};
	const checkDevice = (deviceId: string | null) => {
		if (!deviceId) return;
		const device = z
			.object({ user_id: z.string(), revoked_at: z.string().nullable() })
			.parse(db.prepare("SELECT user_id,revoked_at FROM devices WHERE id=?").get(deviceId));
		if (device.user_id !== actor.userId || device.revoked_at) deny("permission");
	};
	const checkKey = (keyId: string) => {
		const key = keySchema.parse(db.prepare("SELECT * FROM api_keys WHERE id=?").get(keyId));
		if (
			key.user_id !== actor.userId ||
			key.revoked_at ||
			key.kind === "connector" ||
			(key.expires_at && key.expires_at <= new Date().toISOString())
		)
			deny("permission");
		if (global && (key.agent_id !== null || key.allowed_projects_json !== null)) deny("permission");
		if (!z.array(z.string()).parse(JSON.parse(key.permissions_json)).includes(permission)) deny("permission");
		if (key.agent_id && (original.reach.kind !== "own" || key.agent_id !== original.reach.agentId))
			deny("agent_not_permitted");
		intersect(key.allowed_projects_json ? z.array(z.string()).parse(JSON.parse(key.allowed_projects_json)) : null);
		checkDevice(key.device_id);
	};
	if (actor.boundAgentId && (original.reach.kind !== "own" || original.reach.agentId !== actor.boundAgentId))
		deny("agent_not_permitted");
	if (actor.credentialKind === "api_key") checkKey(actor.credentialId);
	else {
		const session = sessionSchema.parse(db.prepare("SELECT * FROM auth_sessions WHERE id=?").get(actor.credentialId));
		if (session.user_id !== actor.userId || session.revoked_at || session.access_expires_at <= new Date().toISOString())
			deny("permission");
		checkDevice(session.device_id);
		if (session.source_key_id) {
			checkKey(session.source_key_id);
			if (!session.source_key_ceiling_json) deny("permission");
			const ceiling = z
				.object({
					permissions: z.array(z.string()),
					agentId: z.string().nullable(),
					projects: z.array(z.string()).nullable(),
					expiresAt: z.string(),
				})
				.parse(JSON.parse(session.source_key_ceiling_json));
			if (global && (ceiling.agentId !== null || ceiling.projects !== null)) deny("permission");
			if (!ceiling.permissions.includes(permission) || ceiling.expiresAt <= new Date().toISOString())
				deny("permission");
			if (ceiling.agentId && (original.reach.kind !== "own" || ceiling.agentId !== original.reach.agentId))
				deny("agent_not_permitted");
			intersect(ceiling.projects);
		}
	}
	const groups = db
		.prepare("SELECT group_id FROM group_members WHERE user_id=?")
		.all<{ group_id: string }>(actor.userId)
		.map((g) => g.group_id);
	if (original.reach.kind !== "own") deny("agent_not_permitted");
	const agent = prepareTypedStatement<AgentRecord>(db, "SELECT * FROM agents WHERE id=?").get(original.reach.agentId);
	if (
		!agent ||
		!canActAs(
			{
				kind: "user",
				role: "admin",
				userId: actor.userId,
				groupIds: groups,
				boundAgentId: actor.boundAgentId,
				credential: { kind: actor.credentialKind, id: actor.credentialId },
			},
			agent,
		)
	)
		deny("agent_not_permitted");
	const visibility = readVisibilitySchema.parse(
		executeClassification(
			{ exec: (sql) => db.exec(sql), prepare: (sql) => prepareTypedStatement<Record<string, unknown>>(db, sql) },
			{ op: "visibility", subject: { userId: actor.userId, groupIds: groups, local: false } },
		),
	);
	const visible = visibility.compartments;
	const compartments =
		visible === "all"
			? original.compartments
			: original.compartments === "all"
				? visible
				: original.compartments.filter((c) => visible.includes(c));
	return {
		...original,
		groupIds: groups,
		compartments,
		projects:
			original.projects === null
				? projects
				: projects === null
					? original.projects
					: original.projects.filter((p) => projects?.includes(p) === true),
		inFlightUserId: actor.userId,
	};
}
function jobRow(db: WriteDb, id: string): OperatorJobRow {
	const row = prepareTypedStatement<OperatorJobRow>(db, "SELECT * FROM org_jobs WHERE id=? AND kind='operator'").get(
		id,
	);
	if (!row) deny("not_found");
	return row;
}
function audit(
	db: WriteDb,
	actor: OperatorActor,
	job: string,
	action: string,
	agentId: string | null,
	detail?: Record<string, unknown>,
) {
	auditAuthoredWriteInTx(
		db,
		{ userId: actor.userId, credential: `${actor.credentialKind}:${actor.credentialId}` },
		action,
		"job",
		job,
		agentId,
		detail,
	);
}
function view(db: WriteDb, actor: OperatorActor, row: OperatorJobRow): OperatorJobRow | null {
	const plan = planSchema.parse(JSON.parse(row.params_json));
	if (actor.boundAgentId && actor.boundAgentId !== plan.scope.reach.agentId) return null;
	let fresh: ReadScope;
	try {
		fresh = actorScope(db, actor, plan.scope, plan.input.action === "embed.audit" ? "diagnostics" : "admin");
	} catch (error) {
		if (error instanceof Error && error.message === "operator:agent_not_permitted") return null;
		throw error;
	}
	const allowed = fresh.compartments;
	if (allowed !== "all" && plan.scope.compartments.some((c) => !allowed.includes(c))) return null;
	if (
		fresh.projects !== null &&
		(plan.scope.projects === null || plan.scope.projects.some((p) => !fresh.projects?.includes(p) === true))
	)
		return null;
	return {
		...row,
		params_json: JSON.stringify({
			action: plan.input.action,
			agentId: plan.scope.reach.agentId,
			dryRun: plan.input.options.dryRun,
		}),
	};
}
function finish(db: WriteDb, row: OperatorJobRow, actor: OperatorActor, reason: string | null) {
	const plan = planSchema.parse(JSON.parse(row.params_json));
	const counts = z
		.object({ missing: z.number().optional(), affected: z.number().optional() })
		.parse(JSON.parse(row.progress_json ?? "{}"));
	const incomplete =
		!reason &&
		plan.input.action === "embed.backfill" &&
		!plan.input.options.dryRun &&
		(counts.missing ?? 0) > (counts.affected ?? 0);
	const status = reason ? "failed" : incomplete ? "incomplete" : "complete";
	db.prepare("UPDATE org_jobs SET status=?,error=?,finished_at=? WHERE id=?").run(
		status,
		reason ?? (incomplete ? "batch_limit" : null),
		new Date().toISOString(),
		row.id,
	);
	audit(
		db,
		actor,
		row.id,
		status === "complete" ? "operator.job_completed" : `operator.job_${status}`,
		plan.scope.reach.agentId,
		{ action: plan.input.action, reason },
	);
}
interface UpgradeLegacyAgent {
	readonly id: string;
	readonly name: string;
	readonly kind: "legacy";
	readonly owner_user_id: string | null;
	readonly owner_group_id: string | null;
}
interface UpgradeLegacyKey {
	readonly id: string;
	readonly name: string;
	readonly prefix: string;
	readonly agent_id: string | null;
	readonly permissions_json: string;
	readonly scope_json: string;
	readonly allowed_projects_json: string | null;
}
const upgradeSavedSchema = z.object({
	version: z.literal(1),
	revision: z.string(),
	input: upgradePlanSchema,
	preview: upgradePreviewSchema,
	fingerprint: z.string(),
	previousDeadline: z.string().nullable(),
	actor: actorSchema,
	deadlineAt: z.string().nullable(),
});
const upgradeProgressSchema = z.object({
	phase: z.enum(["draft", "applying", "complete", "cancelled"]),
	cursor: z.number().int().min(0),
});
function upgradeInventory(db: WriteDb, actor: OperatorActor) {
	const visible = visibleAgentSql({ kind: "user", userId: actor.userId, boundAgentId: actor.boundAgentId });
	const agents = db
		.prepare(
			`SELECT id,name,kind,owner_user_id,owner_group_id FROM agents a WHERE kind='legacy' AND archived_at IS NULL AND ${visible.sql} ORDER BY id LIMIT ?`,
		)
		.all<UpgradeLegacyAgent>(...visible.args, UPGRADE_AGENT_LIMIT + 1);
	const keys = db
		.prepare(
			`SELECT id,name,prefix,agent_id,permissions_json,scope_json,allowed_projects_json FROM api_keys k WHERE legacy=1 AND user_id IS NULL AND revoked_at IS NULL AND (k.agent_id IS NULL OR EXISTS(SELECT 1 FROM agents a WHERE a.id=k.agent_id AND ${visible.sql})) ORDER BY id LIMIT ?`,
		)
		.all<UpgradeLegacyKey>(...visible.args, UPGRADE_KEY_LIMIT + 1);
	if (agents.length > UPGRADE_AGENT_LIMIT || keys.length > UPGRADE_KEY_LIMIT) deny("upgrade_inventory_limit");
	const settings = prepareTypedStatement<{ legacy_key_deadline: string | null }>(
		db,
		"SELECT legacy_key_deadline FROM organization WHERE id=1",
	).get();
	if (!settings) deny("not_found");
	return { agents, keys, legacyKeyDeadline: settings.legacy_key_deadline };
}
function upgradePlan(db: WriteDb, input: UpgradePlanInput, actor: OperatorActor) {
	const inventory = upgradeInventory(db, actor);
	const mappings = new Map(input.mappings.map((row) => [row.agentId, row]));
	const keys = new Map(input.keys.map((row) => [row.id, row]));
	if (
		input.mappings.some((row) => !inventory.agents.some((agent) => agent.id === row.agentId)) ||
		input.keys.some((row) => !inventory.keys.some((key) => key.id === row.id))
	)
		deny("upgrade_inventory_changed");
	const activeUser = (id: string) => {
		if (!db.prepare("SELECT id FROM users WHERE id=? AND status='active'").get(id)) deny("upgrade_owner_unavailable");
	};
	for (const row of input.mappings) {
		if (row.kind === "personal") activeUser(row.ownerUserId);
		if (row.kind === "team" && !db.prepare("SELECT id FROM groups WHERE id=?").get(row.ownerGroupId))
			deny("upgrade_owner_unavailable");
	}
	for (const row of input.keys) if (row.action === "assign") activeUser(row.userId);
	const preview: UpgradePreview = {
		agents: inventory.agents.map((agent) => {
			const mapping = mappings.get(agent.id);
			return {
				agentId: agent.id,
				name: agent.name,
				kind: mapping?.kind ?? "organization",
				ownerUserId: mapping?.kind === "personal" ? mapping.ownerUserId : null,
				ownerGroupId: mapping?.kind === "team" ? mapping.ownerGroupId : null,
				fallback: mapping === undefined,
			};
		}),
		keys: inventory.keys.map((key) => {
			const action = keys.get(key.id);
			return {
				id: key.id,
				name: key.name,
				prefix: key.prefix,
				agentId: key.agent_id,
				action: action?.action ?? "keep-unassigned",
				userId: action?.action === "assign" ? action.userId : null,
			};
		}),
		legacyKeyDeadline: input.legacyKeyDeadline,
		organizationAgentId: "default",
		evidencePolicy: "preserve-agent-ids-and-evidence",
		retainedStorePolicy: ORGANIZATION_RETAINED_STORE_POLICY,
	};
	return {
		preview,
		previousDeadline: inventory.legacyKeyDeadline,
		fingerprint: createHash("sha256").update(JSON.stringify(inventory)).digest("hex"),
	};
}
function visibleUpgradeJobsSql(actor: OperatorActor) {
	const visible = visibleAgentSql({ kind: "user", userId: actor.userId, boundAgentId: actor.boundAgentId });
	return {
		sql: `NOT EXISTS(SELECT 1 FROM json_each(j.params_json,'$.preview.agents') item WHERE NOT EXISTS(SELECT 1 FROM agents a WHERE a.id=json_extract(item.value,'$.agentId') AND ${visible.sql})) AND NOT EXISTS(SELECT 1 FROM json_each(j.params_json,'$.preview.keys') item WHERE json_extract(item.value,'$.agentId') IS NOT NULL AND NOT EXISTS(SELECT 1 FROM agents a WHERE a.id=json_extract(item.value,'$.agentId') AND ${visible.sql}))`,
		args: [...visible.args, ...visible.args],
	};
}
function upgradeJob(db: WriteDb, jobId: string, actor?: OperatorActor) {
	const visible = actor ? visibleUpgradeJobsSql(actor) : { sql: "1=1", args: [] };
	const row = prepareTypedStatement<OperatorJobRow>(
		db,
		`SELECT id,kind,status,created_by,params_json,progress_json,error,created_at,finished_at FROM org_jobs j WHERE id=? AND kind='organization_upgrade' AND ${visible.sql}`,
	).get(jobId, ...visible.args);
	if (!row) deny("not_found");
	return row;
}
function upgradeView(row: OperatorJobRow): UpgradeView {
	const saved = upgradeSavedSchema.parse(JSON.parse(row.params_json));
	const progress = upgradeProgressSchema.parse(JSON.parse(row.progress_json ?? "{}"));
	return {
		id: row.id,
		kind: "organization_upgrade",
		created_at: row.created_at,
		revision: saved.revision,
		status: row.status,
		phase: progress.phase,
		preview: saved.preview,
		appliedPlan: progress.phase === "complete" ? saved.preview : null,
		completedSteps: progress.cursor,
		totalSteps:
			saved.preview.agents.length + saved.preview.keys.filter((key) => key.action !== "keep-unassigned").length + 1,
		error: row.error,
	};
}
function applyLegacyAgentMapping(db: WriteDb, actor: OperatorActor, change: UpgradePreview["agents"][number]) {
	if (
		change.kind === "personal" &&
		!db.prepare("SELECT id FROM users WHERE id=? AND status='active'").get(change.ownerUserId)
	)
		deny("upgrade_owner_unavailable");
	if (change.kind === "team" && !db.prepare("SELECT id FROM groups WHERE id=?").get(change.ownerGroupId))
		deny("upgrade_owner_unavailable");
	const result = db
		.prepare(
			"UPDATE agents SET kind=?,owner_user_id=?,owner_group_id=?,updated_at=? WHERE id=? AND (kind='legacy' OR id='default') AND archived_at IS NULL",
		)
		.run(change.kind, change.ownerUserId, change.ownerGroupId, new Date().toISOString(), change.agentId);
	if (result.changes < 1) deny("upgrade_inventory_changed");
	auditAuthoredWriteInTx(
		db,
		{ userId: actor.userId, credential: `${actor.credentialKind}:${actor.credentialId}` },
		"agent.mapped",
		"agent",
		change.agentId,
		change.agentId,
		{ kind: change.kind },
	);
}
function applyLegacyKeyAssignment(db: WriteDb, actor: OperatorActor, keyId: string, userId: string) {
	const user = prepareTypedStatement<{ role: string }>(db, "SELECT role FROM users WHERE id=? AND status='active'").get(
		userId,
	);
	if (!user) deny("upgrade_owner_unavailable");
	const key = prepareTypedStatement<{ agent_id: string | null; scope_json: string }>(
		db,
		"SELECT agent_id,scope_json FROM api_keys WHERE id=? AND kind='legacy' AND user_id IS NULL AND revoked_at IS NULL",
	).get(keyId);
	if (!key) deny("upgrade_inventory_changed");
	const scope = z.object({ user: z.string().optional() }).passthrough().parse(JSON.parse(key.scope_json));
	if (scope.user && scope.user !== userId) deny("upgrade_owner_unavailable");
	if (key.agent_id) {
		const agent = prepareTypedStatement<AgentRecord>(
			db,
			"SELECT id,kind,owner_user_id,owner_group_id,archived_at FROM agents WHERE id=?",
		).get(key.agent_id);
		const groups = db
			.prepare("SELECT group_id FROM group_members WHERE user_id=?")
			.all<{ group_id: string }>(userId)
			.map((row) => row.group_id);
		const role = z.enum(["admin", "operator", "member", "readonly", "agent"]).parse(user.role);
		if (
			!agent ||
			!canActAs(
				{
					kind: "user",
					role,
					userId,
					groupIds: groups,
					credential: { kind: "api_key", id: keyId },
					boundAgentId: key.agent_id,
				},
				agent,
			)
		)
			deny("upgrade_owner_unavailable");
	}
	db.prepare("UPDATE api_keys SET user_id=?,legacy=0 WHERE id=?").run(userId, keyId);
	auditAuthoredWriteInTx(
		db,
		{ userId: actor.userId, credential: `${actor.credentialKind}:${actor.credentialId}` },
		"key.assigned",
		"key",
		keyId,
		key.agent_id,
		{ userId },
	);
}
function advanceUpgrade(db: WriteDb, jobId: string): UpgradeView {
	const row = upgradeJob(db, jobId);
	const saved = upgradeSavedSchema.parse(JSON.parse(row.params_json));
	const progress = upgradeProgressSchema.parse(JSON.parse(row.progress_json ?? "{}"));
	if (row.status !== "running" || progress.phase !== "applying") return upgradeView(row);
	const actor = saved.actor;
	db.exec("SAVEPOINT organization_upgrade_batch");
	try {
		if (!db.prepare("SELECT id FROM users WHERE id=? AND status='active' AND role='admin'").get(actor.userId))
			deny("upgrade_approval_revoked");
		if (!saved.deadlineAt || saved.deadlineAt <= new Date().toISOString()) deny("upgrade_deadline");
		const changes = [
			...saved.preview.agents.map((agent) => ({ kind: "agent" as const, agent })),
			...saved.preview.keys
				.filter((key) => key.action !== "keep-unassigned")
				.map((key) => ({ kind: "key" as const, key })),
		];
		const end = Math.min(progress.cursor + UPGRADE_BATCH_SIZE, changes.length);
		for (const change of changes.slice(progress.cursor, end)) {
			if (change.kind === "agent") applyLegacyAgentMapping(db, actor, change.agent);
			else if (change.key.action === "assign" && change.key.userId)
				applyLegacyKeyAssignment(db, actor, change.key.id, change.key.userId);
			else {
				const revoked = db
					.prepare(
						"UPDATE api_keys SET revoked_at=? WHERE id=? AND legacy=1 AND user_id IS NULL AND revoked_at IS NULL",
					)
					.run(new Date().toISOString(), change.key.id);
				if (revoked.changes < 1) deny("upgrade_inventory_changed");
				auditAuthoredWriteInTx(
					db,
					{ userId: actor.userId, credential: `${actor.credentialKind}:${actor.credentialId}` },
					"key.revoked",
					"key",
					change.key.id,
					change.key.agentId,
				);
			}
		}
		const done = end === changes.length;
		if (done) {
			const updated = db
				.prepare("UPDATE organization SET legacy_key_deadline=?,updated_at=? WHERE id=1 AND legacy_key_deadline IS ?")
				.run(saved.preview.legacyKeyDeadline, new Date().toISOString(), saved.previousDeadline);
			if (updated.changes < 1) deny("upgrade_inventory_changed");
		}
		db.prepare("UPDATE org_jobs SET status=?,progress_json=?,finished_at=?,error=NULL WHERE id=?").run(
			done ? "complete" : "running",
			JSON.stringify({ phase: done ? "complete" : "applying", cursor: done ? end + 1 : end }),
			done ? new Date().toISOString() : null,
			row.id,
		);
		audit(db, actor, row.id, done ? "organization.upgrade_completed" : "organization.upgrade_batch", null, {
			completedSteps: done ? end + 1 : end,
		});
		db.exec("RELEASE organization_upgrade_batch");
	} catch (error) {
		db.exec("ROLLBACK TO organization_upgrade_batch");
		db.exec("RELEASE organization_upgrade_batch");
		const reason =
			error instanceof Error && error.message.startsWith("operator:")
				? error.message.slice("operator:".length)
				: "upgrade_batch_failed";
		db.prepare("UPDATE org_jobs SET status='failed',error=?,finished_at=? WHERE id=?").run(
			reason,
			new Date().toISOString(),
			row.id,
		);
		audit(db, actor, row.id, "organization.upgrade_failed", null, { reason });
	}
	return upgradeView(upgradeJob(db, row.id));
}

function upgradeOperation(db: WriteDb, request: UpgradeRequest): unknown {
	const command = request.command;
	if (command.action === "recover")
		return db
			.prepare(
				"SELECT id FROM org_jobs WHERE kind='organization_upgrade' AND status='running' ORDER BY created_at LIMIT 1",
			)
			.all<{ id: string }>();
	if (command.action === "next") return advanceUpgrade(db, command.jobId);
	if (!request.actor) deny("permission");
	operation(db, { op: "authorize-global", actor: request.actor });
	const actor = request.actor;
	const visibleJobs = visibleUpgradeJobsSql(actor);
	if (command.action === "map-agent") {
		const mapping = command.mapping;
		if (mapping.kind === "organization" && command.agentId !== "default") deny("org_policy");
		applyLegacyAgentMapping(db, actor, {
			agentId: command.agentId,
			name: "",
			kind: mapping.kind,
			ownerUserId: mapping.kind === "personal" ? mapping.ownerUserId : null,
			ownerGroupId: mapping.kind === "team" ? mapping.ownerGroupId : null,
			fallback: false,
		});
		return { ok: true };
	}
	if (command.action === "assign-key") {
		applyLegacyKeyAssignment(db, actor, command.keyId, command.userId);
		return { ok: true };
	}
	if (command.action === "list")
		return db
			.prepare(
				`SELECT id,kind,status,created_by,params_json,progress_json,error,created_at,finished_at FROM org_jobs j WHERE kind='organization_upgrade' AND ${visibleJobs.sql} ORDER BY created_at DESC LIMIT 100`,
			)
			.all<OperatorJobRow>(...visibleJobs.args)
			.map(upgradeView);
	if (command.action === "inventory") {
		const inventory = upgradeInventory(db, actor);
		return {
			agents: inventory.agents,
			keys: inventory.keys.map((key) => ({ id: key.id, name: key.name, prefix: key.prefix, agentId: key.agent_id })),
			legacyKeyDeadline: inventory.legacyKeyDeadline,
			users: db.prepare("SELECT id,display_name AS name FROM users WHERE status='active' ORDER BY id LIMIT 1000").all(),
			groups: db.prepare("SELECT id,name FROM groups ORDER BY id LIMIT 1000").all(),
			jobs: db
				.prepare(
					`SELECT id,kind,status,created_by,params_json,progress_json,error,created_at,finished_at FROM org_jobs j WHERE kind='organization_upgrade' AND ${visibleJobs.sql} ORDER BY created_at DESC LIMIT 8`,
				)
				.all<OperatorJobRow>(...visibleJobs.args)
				.map(upgradeView),
		};
	}
	if (command.action === "preview") {
		const pending = db
			.prepare("SELECT id FROM org_jobs WHERE kind='organization_upgrade' AND status='pending' LIMIT 8")
			.all();
		if (pending.length >= 8) deny("capacity");
		const plan = upgradePlan(db, command.plan, actor);
		const id = `job_${randomUUID().replaceAll("-", "")}`;
		const saved = { version: 1, revision: randomUUID(), input: command.plan, ...plan, actor, deadlineAt: null };
		db.prepare(
			"INSERT INTO org_jobs(id,kind,status,params_json,progress_json,created_by,created_at) VALUES(?,'organization_upgrade','pending',?,?,?,?)",
		).run(
			id,
			JSON.stringify(saved),
			JSON.stringify({ phase: "draft", cursor: 0 }),
			actor.userId,
			new Date().toISOString(),
		);
		audit(db, actor, id, "organization.upgrade_previewed", null);
		return upgradeView(upgradeJob(db, id));
	}
	const row = upgradeJob(db, command.jobId, actor);
	if (command.action === "read") return upgradeView(row);
	const saved = upgradeSavedSchema.parse(JSON.parse(row.params_json));
	const progress = upgradeProgressSchema.parse(JSON.parse(row.progress_json ?? "{}"));
	if (command.action === "resume") {
		if (saved.revision !== command.revision || progress.phase !== "applying" || row.status !== "failed")
			deny("upgrade_revision_conflict");
		const blocker = db
			.prepare("SELECT id FROM org_jobs WHERE kind='organization_upgrade' AND status='running' AND id<>? LIMIT 1")
			.get(row.id);
		if (blocker) deny("capacity");
		db.prepare("UPDATE org_jobs SET status='running',params_json=?,error=NULL,finished_at=NULL WHERE id=?").run(
			JSON.stringify({ ...saved, actor, deadlineAt: new Date(Date.now() + 86400_000).toISOString() }),
			row.id,
		);
		audit(db, actor, row.id, "organization.upgrade_resumed", null);
		return upgradeView(upgradeJob(db, row.id));
	}
	if (saved.revision !== command.revision || progress.phase !== "draft" || row.status !== "pending")
		deny("upgrade_revision_conflict");
	if (command.action === "confirm") {
		const current = upgradePlan(db, saved.input, actor);
		if (current.fingerprint !== saved.fingerprint || JSON.stringify(current.preview) !== JSON.stringify(saved.preview))
			deny("upgrade_inventory_changed");
		if (
			db
				.prepare(
					"SELECT id FROM org_jobs WHERE kind='organization_upgrade' AND json_extract(progress_json,'$.phase')='applying' AND id<>? LIMIT 1",
				)
				.get(row.id)
		)
			deny("capacity");
		db.prepare("UPDATE org_jobs SET status='running',params_json=?,progress_json=?,started_at=? WHERE id=?").run(
			JSON.stringify({ ...saved, actor, deadlineAt: new Date(Date.now() + 86400_000).toISOString() }),
			JSON.stringify({ phase: "applying", cursor: 0 }),
			new Date().toISOString(),
			row.id,
		);
		audit(db, actor, row.id, "organization.upgrade_confirmed", null, { revision: saved.revision });
		return upgradeView(upgradeJob(db, row.id));
	}
	if (command.action === "revise") {
		const next = {
			...saved,
			...upgradePlan(db, command.plan, actor),
			input: command.plan,
			revision: randomUUID(),
			actor,
		};
		db.prepare("UPDATE org_jobs SET params_json=? WHERE id=?").run(JSON.stringify(next), row.id);
		audit(db, actor, row.id, "organization.upgrade_revised", null);
		return upgradeView(upgradeJob(db, row.id));
	}
	if (command.action === "cancel") {
		db.prepare("UPDATE org_jobs SET status='cancelled',progress_json=?,finished_at=? WHERE id=?").run(
			JSON.stringify({ phase: "cancelled", cursor: 0 }),
			new Date().toISOString(),
			row.id,
		);
		audit(db, actor, row.id, "organization.upgrade_cancelled", null);
		return upgradeView(upgradeJob(db, row.id));
	}
	deny("upgrade_not_confirmed");
}

export function executeOperatorJob(db: WriteDb, request: OperatorRequest): unknown {
	db.exec("BEGIN IMMEDIATE");
	try {
		const result = operation(db, request);
		db.exec("COMMIT");
		return result;
	} catch (error) {
		db.exec("ROLLBACK");
		throw error;
	}
}
function sweepOperatorJobs(db: WriteDb, runtimeId: string | undefined): void {
	const cutoff = new Date(Date.now() - 30 * 86_400_000).toISOString();
	const stale = db
		.prepare(
			"SELECT * FROM org_jobs WHERE kind='operator' AND status IN ('pending','running') AND (created_at<=? OR json_extract(params_json,'$.runtimeId')<>?) ORDER BY created_at LIMIT 100",
		)
		.all<OperatorJobRow>(new Date(Date.now() - 60_000).toISOString(), runtimeId ?? "");
	for (const row of stale) {
		const plan = planSchema.parse(JSON.parse(row.params_json));
		finish(
			db,
			row,
			plan.actor,
			Date.now() >= Date.parse(row.created_at) + 60_000 ? "deadline_exceeded" : "daemon_restarted",
		);
	}
	for (const [table, predicate, column, cap] of [
		["org_jobs", "kind='operator' AND status NOT IN ('pending','running')", "finished_at", 1000],
		["audit_events", "action LIKE 'operator.%'", "at", 10000],
	] as const) {
		db.prepare(
			`DELETE FROM ${table} WHERE id IN (SELECT id FROM ${table} WHERE ${predicate} AND (${column}<? OR id IN (SELECT id FROM ${table} WHERE ${predicate} ORDER BY ${column} DESC,id DESC LIMIT 100 OFFSET ${cap})) ORDER BY ${column},id LIMIT 100)`,
		).run(cutoff);
	}
}
function operation(db: WriteDb, request: OperatorRequest): unknown {
	if (request.op === "list" || request.op === "create" || (request.op === "logs-access" && request.audit))
		sweepOperatorJobs(db, request.runtimeId);
	if (request.op === "organization-upgrade") return upgradeOperation(db, request);
	if (request.op === "settings") {
		operation(db, { op: "authorize-global", actor: request.actor });
		const data = settingsSchema.parse(request.input);
		const current = prepareTypedStatement<OrganizationRow>(db, "SELECT * FROM organization WHERE id=1").get();
		if (!current) deny("not_found");
		const nextOidc = data.oidc === undefined ? current.oidc_json : data.oidc;
		if (
			((data.passwordLogin ?? Boolean(current.password_login)) === false ||
				(data.requireSso ?? Boolean(current.require_sso))) &&
			!nextOidc
		)
			deny("org_policy");
		for (const [key, column] of Object.entries(settingsColumns)) {
			const value: unknown = Reflect.get(data, key);
			if (value === undefined) continue;
			const normalized =
				key === "oidc"
					? value === null
						? null
						: JSON.stringify(value)
					: typeof value === "boolean"
						? Number(value)
						: value;
			if (typeof normalized !== "string" && typeof normalized !== "number" && normalized !== null)
				deny("invalid_request");
			db.prepare(`UPDATE organization SET ${column}=?,updated_at=? WHERE id=1`).run(
				normalized,
				new Date().toISOString(),
			);
		}
		auditAuthoredWriteInTx(
			db,
			{ userId: request.actor.userId, credential: `${request.actor.credentialKind}:${request.actor.credentialId}` },
			"organization.settings_updated",
			"organization",
			"1",
			null,
			{ fields: Object.keys(data) },
		);
		return { ok: true };
	}

	if (request.op === "logs-access") {
		operation(db, { op: "authorize-global", actor: request.actor });
		const agent = z
			.object({ id: z.string() })
			.parse(db.prepare("SELECT id FROM agents WHERE kind='organization' AND archived_at IS NULL LIMIT 1").get());
		const scope = actorScope(
			db,
			request.actor,
			{ reach: { kind: "own", agentId: request.subjectAgentId ?? agent.id }, projects: null, compartments: "all" },
			"diagnostics",
			true,
		);
		if (
			request.audit &&
			!db
				.prepare("SELECT 1 FROM audit_events WHERE actor_user_id=? AND action='operator.logs_opened' AND at>=? LIMIT 1")
				.get(request.actor.userId, new Date(Math.floor(Date.now() / 60_000) * 60_000).toISOString())
		)
			auditAuthoredWriteInTx(
				db,
				{ userId: request.actor.userId, credential: `${request.actor.credentialKind}:${request.actor.credentialId}` },
				"operator.logs_opened",
				"operator",
				"logs",
				null,
			);
		return { compartments: scope.compartments, groupIds: scope.groupIds };
	}
	if (request.op === "agent-purge") return agentPurge(db, request);
	if (request.op === "authorize-global") {
		if (request.actor.boundAgentId !== null || request.actor.allowedProjects !== null) deny("permission");
		const agent = db.prepare("SELECT id FROM agents WHERE kind='organization' AND archived_at IS NULL LIMIT 1").get();
		const id = z.string().parse(agent?.id);
		actorScope(
			db,
			request.actor,
			{ reach: { kind: "own", agentId: id }, projects: null, compartments: [] },
			"admin",
			true,
		);
		return { ok: true };
	}
	if (request.op === "list") {
		const actor = request.actor;
		const groups = db
			.prepare("SELECT group_id FROM group_members WHERE user_id=?")
			.all<{ group_id: string }>(actor.userId)
			.map((g) => g.group_id);
		const visible = readVisibilitySchema.parse(
			executeClassification(
				{ exec: (sql) => db.exec(sql), prepare: (sql) => prepareTypedStatement<Record<string, unknown>>(db, sql) },
				{ op: "visibility", subject: { userId: actor.userId, groupIds: groups, local: false } },
			),
		).compartments;
		const where = [
			"j.kind='operator'",
			"EXISTS(SELECT 1 FROM agents a WHERE a.id=json_extract(j.params_json,'$.scope.reach.agentId') AND a.archived_at IS NULL AND (a.kind='organization' OR (a.kind='personal' AND a.owner_user_id=?) OR (a.kind='team' AND EXISTS(SELECT 1 FROM group_members gm WHERE gm.group_id=a.owner_group_id AND gm.user_id=?)) OR a.kind='legacy'))",
		];
		const args: (string | number)[] = [actor.userId, actor.userId];
		if (!actor.permissions.includes("diagnostics"))
			where.push("json_extract(j.params_json,'$.input.action')<>'embed.audit'");
		if (actor.boundAgentId) {
			where.push("json_extract(j.params_json,'$.scope.reach.agentId')=?");
			args.push(actor.boundAgentId);
		}
		if (visible !== "all") {
			where.push(
				`NOT EXISTS(SELECT 1 FROM json_each(j.params_json,'$.scope.compartments') c WHERE c.value NOT IN (${[-1, ...visible].map(() => "?").join(",")}))`,
			);
			args.push(-1, ...visible);
		}
		if (actor.allowedProjects !== null) {
			where.push(
				`json_type(j.params_json,'$.scope.projects')='array' AND NOT EXISTS(SELECT 1 FROM json_each(j.params_json,'$.scope.projects') p WHERE p.value NOT IN (${["", ...actor.allowedProjects].map(() => "?").join(",")}))`,
			);
			args.push("", ...actor.allowedProjects);
		}
		const rows = db
			.prepare(`SELECT j.* FROM org_jobs j WHERE ${where.join(" AND ")} ORDER BY j.created_at DESC LIMIT 100`)
			.all<OperatorJobRow>(...args);
		return rows.flatMap((row) => {
			const result = view(db, actor, row);
			return result ? [result] : [];
		});
	}
	if (request.op === "get") {
		const row = jobRow(db, request.jobId ?? ""),
			visible = view(db, request.actor, row);
		if (!visible) deny("not_found");
		const plan = planSchema.parse(JSON.parse(row.params_json));
		const expired = Date.now() >= Date.parse(row.created_at) + 60_000;
		if (row.status === "running" && ((request.runtimeId && plan.runtimeId !== request.runtimeId) || expired)) {
			finish(db, row, plan.actor, expired ? "deadline_exceeded" : "daemon_restarted");
			return view(db, request.actor, jobRow(db, row.id));
		}
		return visible;
	}
	if (request.op === "create") {
		const input = request.input;
		if (input.action !== "embed.audit" && request.pipeline.autonomous.frozen) deny("repairs_frozen");
		const scope = actorScope(
			db,
			request.actor,
			request.scope,
			input.action === "embed.audit" ? "diagnostics" : "admin",
		);
		const stale = db
			.prepare(
				"SELECT * FROM org_jobs WHERE kind='operator' AND status IN ('pending','running') AND json_extract(params_json,'$.runtimeId')=? AND created_at>? LIMIT 2",
			)
			.all<OperatorJobRow>(request.runtimeId, new Date(Date.now() - 60_000).toISOString());
		if (
			stale.filter(
				(r) =>
					planSchema.parse(JSON.parse(r.params_json)).runtimeId === request.runtimeId &&
					Date.now() < Date.parse(r.created_at) + 60_000,
			).length >= 2
		)
			deny("capacity");
		const minute = new Date(Date.now() - 60_000).toISOString();
		const starts = db
			.prepare(
				"SELECT created_by FROM org_jobs WHERE kind='operator' AND created_at>=? ORDER BY created_at DESC LIMIT 100",
			)
			.all<{ created_by: string }>(minute);
		if (starts.length >= 100 || starts.filter((row) => row.created_by === request.actor.userId).length >= 20)
			deny("capacity");
		const id = `job_${randomUUID().replaceAll("-", "")}`,
			now = new Date().toISOString();
		db.prepare(
			"INSERT INTO org_jobs(id,kind,status,created_by,params_json,created_at,started_at) VALUES(?,'operator','running',?,?,?,?)",
		).run(
			id,
			request.actor.userId,
			JSON.stringify({ input, actor: request.actor, scope, runtimeId: request.runtimeId }),
			now,
			now,
		);
		audit(db, request.actor, id, "operator.job_started", input.agentId ?? null, {
			action: input.action,
			dryRun: input.options.dryRun,
		});
		let progress: Record<string, unknown>;
		let rows: UnembeddedRow[] = [];
		if (input.action.startsWith("queue.")) {
			const ctx = {
				reason: "Organization operator job",
				actor: request.actor.userId,
				actorType: "operator" as const,
				requestId: id,
			};
			const options = { ...input.options, readScope: scope };
			progress =
				input.action === "queue.requeue"
					? requeueDeadJobsInTx(db, ctx, options)
					: input.action === "queue.cancel"
						? cancelObsoleteJobsInTx(db, ctx, options)
						: pruneTerminalJobsInTx(db, ctx, options);
		} else {
			const filter = readScopeSql("m", scope);
			const missing =
				"NOT EXISTS(SELECT 1 FROM embeddings e WHERE e.source_type='memory' AND e.source_id=m.id AND e.agent_id=m.agent_id AND e.content_hash=m.content_hash)";
			const stats = prepareTypedStatement<{ total: number; missing: number }>(
				db,
				`SELECT count(*) AS total,coalesce(sum(CASE WHEN ${missing} THEN 1 ELSE 0 END),0) AS missing FROM memories m WHERE m.is_deleted=0 ${filter.sql}`,
			).get(...filter.args);
			progress = { total: stats?.total ?? 0, missing: stats?.missing ?? 0, affected: 0, dryRun: input.options.dryRun };
			if (input.action === "embed.backfill") {
				rows = db
					.prepare(
						`SELECT m.id,m.content,m.content_hash AS contentHash,m.agent_id AS agentId FROM memories m WHERE m.is_deleted=0 AND length(CAST(m.content AS BLOB))<=32768 AND ${missing} ${filter.sql} ORDER BY m.id LIMIT ?`,
					)
					.all<UnembeddedRow>(...filter.args, Math.min(20, input.options.maxBatch));
				let selectedBytes = 0;
				rows = rows.filter((row) => {
					const bytes = Buffer.byteLength(JSON.stringify(row));
					if (selectedBytes + bytes > 256 * 1024) return false;
					selectedBytes += bytes;
					return true;
				});
				progress = { ...progress, selected: rows.length };
				if (input.options.dryRun) rows = [];
			}
		}
		db.prepare("UPDATE org_jobs SET progress_json=? WHERE id=?").run(JSON.stringify(progress), id);
		if (!rows.length) finish(db, jobRow(db, id), request.actor, null);
		return { jobId: id, rows, embedding: resolveActiveEmbeddingConfig(db, request.embedding) };
	}
	const row = jobRow(db, request.jobId),
		plan = planSchema.parse(JSON.parse(row.params_json));
	if (
		row.status !== "running" ||
		plan.runtimeId !== request.runtimeId ||
		plan.actor.userId !== request.actor.userId ||
		plan.actor.credentialId !== request.actor.credentialId
	)
		deny("not_found");
	if (request.op === "finish") {
		finish(
			db,
			row,
			plan.actor,
			request.error ?? (Date.now() >= Date.parse(row.created_at) + 60_000 ? "deadline_exceeded" : null),
		);
		return { ok: true };
	}
	if (Date.now() >= Date.parse(row.created_at) + 60_000) deny("deadline_exceeded");
	const scope = actorScope(db, request.actor, plan.scope, "admin"),
		filter = readScopeSql("m", scope);
	const allowed = db
		.prepare(`SELECT m.id FROM memories m WHERE m.id=? AND m.is_deleted=0 ${filter.sql}`)
		.get(request.memory.id, ...filter.args);
	if (!allowed) deny("permission");
	if (request.op === "admit") return { ok: true };
	const outcome = commitRepairEmbeddingsInTx(
		db,
		[{ memory: request.memory, vector: request.vector }],
		request.embedding,
	);
	if (outcome.profileChanged || outcome.stale || outcome.count !== 1) deny("source_changed");
	const progress = z
		.object({ affected: z.number() })
		.passthrough()
		.parse(JSON.parse(row.progress_json ?? "{}"));
	db.prepare("UPDATE org_jobs SET progress_json=? WHERE id=?").run(
		JSON.stringify({ ...progress, affected: progress.affected + 1 }),
		row.id,
	);
	return { ok: true };
}

function purgeAdmission(db: WriteDb, agentId: string) {
	const tables = db
		.prepare(
			"SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' AND sql NOT LIKE 'CREATE VIRTUAL TABLE%' LIMIT 513",
		)
		.all<{ name: string }>();
	if (tables.length > 512) deny("purge_limit");
	let count = 0;
	for (const { name } of tables) {
		if (name === "audit_events") continue;
		if (!/^[a-zA-Z0-9_]+$/.test(name)) deny("purge_limit");
		if (
			!db
				.prepare(`PRAGMA table_info("${name}")`)
				.all<{ name: string }>()
				.some((column) => column.name === "agent_id")
		)
			continue;
		count += db.prepare(`SELECT 1 FROM "${name}" WHERE agent_id=? LIMIT ?`).all(agentId, 1001 - count).length;
		if (count > 1000) deny("purge_limit");
	}
}
function agentPurge(db: WriteDb, request: Extract<OperatorRequest, { op: "agent-purge" }>) {
	if (request.stage !== "fail") operation(db, { op: "authorize-global", actor: request.actor });
	const now = new Date().toISOString();
	if (request.stage === "create") {
		const agentId = z.string().min(1).max(200).parse(request.agentId);
		const agent = prepareTypedStatement<AgentRecord>(db, "SELECT * FROM agents WHERE id=?").get(agentId);
		if (!agent) deny("not_found");
		if (agentId === "default" || agent.kind === "organization") deny("protected_agent");
		if (!agent.archived_at) deny("purge_requires_archive");

		const pending = db
			.prepare("SELECT id,params_json,created_at FROM org_jobs WHERE kind='agent_purge' AND status='running' LIMIT 3")
			.all<{ id: string; params_json: string; created_at: string }>();
		let live = 0;
		for (const row of pending) {
			const plan = z.object({ runtimeId: z.string() }).parse(JSON.parse(row.params_json));
			if (plan.runtimeId !== request.runtimeId || Date.now() - Date.parse(row.created_at) > 60_000) {
				db.prepare("UPDATE org_jobs SET status='incomplete',error='purge_interrupted',finished_at=? WHERE id=?").run(
					now,
					row.id,
				);
				audit(db, request.actor, row.id, "agent.purge_incomplete", null, { status: "interrupted" });
			} else live++;
		}
		if (live >= 2) deny("capacity");
		if (
			db
				.prepare(
					"SELECT 1 FROM org_jobs WHERE kind='agent_purge' AND status='running' AND json_extract(params_json,'$.agentId')=? LIMIT 1",
				)
				.get(agentId)
		)
			deny("capacity");
		purgeAdmission(db, agentId);
		const jobId = `job_${randomUUID().replaceAll("-", "")}`;
		db.prepare(
			"INSERT INTO org_jobs(id,kind,status,created_by,params_json,progress_json,created_at) VALUES(?,'agent_purge','running',?,?,'{}',?)",
		).run(jobId, request.actor.userId, JSON.stringify({ agentId, runtimeId: request.runtimeId }), now);
		audit(db, request.actor, jobId, "agent.purge_started", null, { agentId });
		return { jobId };
	}
	const row = prepareTypedStatement<OperatorJobRow>(db, "SELECT * FROM org_jobs WHERE id=? AND kind='agent_purge'").get(
		request.jobId ?? "",
	);
	if (!row) deny("not_found");
	const plan = z.object({ agentId: z.string(), runtimeId: z.string() }).parse(JSON.parse(row.params_json));
	const settle = (status: string, error: string | null) => {
		db.prepare("UPDATE org_jobs SET status=?,error=?,finished_at=? WHERE id=? AND status='running'").run(
			status,
			error,
			now,
			row.id,
		);
		audit(db, request.actor, row.id, status === "complete" ? "agent.purged" : "agent.purge_incomplete", null, {
			agentId: plan.agentId,
			status,
		});
		return { ...row, status, error, finished_at: now, params_json: JSON.stringify({ agentId: plan.agentId }) };
	};
	if (request.stage === "fail") {
		if (row.created_by !== request.actor.userId || plan.runtimeId !== request.runtimeId) deny("permission");
		return row.status === "running" ? settle("incomplete", "purge_incomplete") : row;
	}
	if (request.stage === "read") {
		if (
			row.status === "running" &&
			(plan.runtimeId !== request.runtimeId || Date.now() - Date.parse(row.created_at) > 60_000)
		)
			return settle("incomplete", "purge_interrupted");
		return { ...row, params_json: JSON.stringify({ agentId: plan.agentId }) };
	}
	if (
		row.status !== "running" ||
		row.created_by !== request.actor.userId ||
		plan.runtimeId !== request.runtimeId ||
		Date.now() - Date.parse(row.created_at) > 60_000
	)
		deny("permission");
	const agent = prepareTypedStatement<AgentRecord>(db, "SELECT * FROM agents WHERE id=?").get(plan.agentId);
	if (!agent?.archived_at) deny("purge_requires_archive");
	if (request.stage === "next") {
		const batch = purgeAuthoredMemoryBatchInTx(
			db,
			request.actor.userId,
			{ userId: request.actor.userId, credential: `${request.actor.credentialKind}:${request.actor.credentialId}` },
			{ agentId: plan.agentId },
		);
		if (batch.blocked) deny("purge_blocked");
		if (Object.values(batch.counts).some((n) => n > 0)) return { more: true };
		const transcript = prepareTypedStatement<{ session_key: string }>(
			db,
			"SELECT session_key FROM session_transcripts WHERE agent_id=? UNION SELECT session_key FROM session_transcript_deletions WHERE agent_id=? AND phase<>'complete' LIMIT 1",
		).get(plan.agentId, plan.agentId);
		return { more: false, sessionKey: transcript?.session_key, agentId: plan.agentId };
	}
	if (
		db
			.prepare(
				"SELECT 1 FROM session_transcripts WHERE agent_id=? UNION SELECT 1 FROM session_transcript_deletions WHERE agent_id=? AND phase<>'complete' LIMIT 1",
			)
			.get(plan.agentId, plan.agentId)
	)
		deny("purge_blocked");
	purgeAdmission(db, plan.agentId);
	db.prepare(
		"UPDATE users SET personal_agent_id=CASE WHEN personal_agent_id=? THEN NULL ELSE personal_agent_id END,default_read_agent_id=CASE WHEN default_read_agent_id=? THEN NULL ELSE default_read_agent_id END WHERE personal_agent_id=? OR default_read_agent_id=?",
	).run(plan.agentId, plan.agentId, plan.agentId, plan.agentId);
	const result = removeAgentInTx(db, {
		agentId: plan.agentId,
		mode: "purge",
		changedBy: `user:${request.actor.userId}`,
		changedAt: now,
	});
	if (result.status !== "removed") deny("not_found");
	return settle("complete", null);
}
