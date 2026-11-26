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
function actorScope(db: WriteDb, actor: OperatorActor, original: ReadScope, permission: string): ReadScope {
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
	const fresh = actorScope(db, actor, plan.scope, plan.input.action === "embed.audit" ? "diagnostics" : "admin");
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
function operation(db: WriteDb, request: OperatorRequest): unknown {
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
		const where = ["j.kind='operator'"];
		const args: (string | number)[] = [];
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
			.prepare("SELECT * FROM org_jobs WHERE kind='operator' AND status IN ('pending','running') LIMIT 3")
			.all<OperatorJobRow>();
		for (const old of stale) {
			const plan = planSchema.parse(JSON.parse(old.params_json));
			if (plan.runtimeId !== request.runtimeId || Date.now() >= Date.parse(old.created_at) + 60_000)
				finish(db, old, plan.actor, "interrupted");
		}
		if (
			stale.filter(
				(r) =>
					planSchema.parse(JSON.parse(r.params_json)).runtimeId === request.runtimeId &&
					Date.now() < Date.parse(r.created_at) + 60_000,
			).length >= 2
		)
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
		return { jobId: id, rows };
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
