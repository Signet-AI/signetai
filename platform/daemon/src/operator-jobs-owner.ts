import { settingsSchema, settingsColumns } from "./auth/organization-settings-contract";
import type { OrganizationRow } from "./auth/organization-store";
import { removeAgentInTx } from "./agent-removal";
import { purgeAuthoredMemoryBatchInTx } from "./auth/organization-purge";
import { canActAs, type AgentRecord } from "./auth/agent-access";
import { randomUUID } from "node:crypto";
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
): ReadScope {
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
			{ reach: { kind: "own", agentId: agent.id }, projects: null, compartments: "all" },
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
		return { compartments: scope.compartments };
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
