import { attemptAsync } from "@signet/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { resolveReadScope, readVisibilitySchema, audienceSubjectFromPrincipal } from "../read-scope";
import {
	classificationRequest,
	executeClassificationJob,
	type ClassificationRequest,
	type ClassificationActor,
} from "../classifications";

const principalSchema = z.object({
	kind: z.enum(["local", "user", "legacy"]),
	userId: z.string().nullable(),
	groupIds: z.array(z.string()),
	compliance: z.boolean(),
	permissions: z.set(z.string()),
	credential: z.object({ kind: z.string(), id: z.string() }),
	allowedProjects: z.array(z.string()).nullable(),
	boundAgentId: z.string().nullable(),
});
const person = z.object({ kind: z.enum(["user", "group"]), id: z.string().min(1).max(200) }).strict();
const target = z
	.object({
		kind: z.enum(["memory", "session", "source", "agent"]),
		id: z.string().min(1).max(4096),
		agentId: z.string().min(1).max(200),
	})
	.strict();
const create = z
	.object({
		name: z.string().trim().min(1).max(200),
		color: z.string().max(64).optional(),
		description: z.string().max(4096).optional(),
		audience: z.array(person).max(1000),
		appliers: z.array(person).max(1000).optional(),
	})
	.strict();
const update = create
	.pick({ name: true, color: true, description: true })
	.partial()
	.extend({ archived: z.boolean().optional() })
	.strict();
export interface ClassificationRoutesOptions {
	readonly request?: (request: ClassificationRequest) => Promise<unknown>;
}
export function registerClassificationRoutes(parent: Hono, options: ClassificationRoutesOptions = {}): void {
	const app = new Hono();
	const request: (request: ClassificationRequest) => Promise<unknown> = options.request ?? classificationRequest;
	const reply = (value: unknown, status = 200): Response => {
		const response = Response.json(value, { status });
		if (status === 401) response.headers.set("WWW-Authenticate", "Bearer");
		return response;
	};
	const actor = (
		c: Context,
	): { actor: ClassificationActor; projects: readonly string[] | null; canClassify: boolean } => {
		const result = principalSchema.safeParse(c.get("principal"));
		if (
			!result.success ||
			result.data.kind === "legacy" ||
			(result.data.kind === "user" && result.data.userId === null)
		)
			throw new Error("unauthorized");
		const p = result.data;
		return {
			actor: {
				...audienceSubjectFromPrincipal(p),
				compliance: p.compliance,
				boundAgentId: p.boundAgentId,
				allowedProjects: p.allowedProjects,
				credential: `${p.credential.kind}:${p.credential.id}`,
			},
			projects: p.allowedProjects,
			canClassify: p.kind === "local" || p.permissions.has("classify"),
		};
	};
	app.onError((error, _c) => {
		const reason = error.message;
		if (reason === "not_found") return reply({ error: "Not found" }, 404);
		if (reason === "unauthorized") return reply({ error: "Unauthorized", reason: "missing_credential" }, 401);
		if (
			reason === "permission" ||
			reason === "not_owner" ||
			reason === "agent_binding_conflict" ||
			reason === "project_not_permitted"
		)
			return reply({ error: "Forbidden", reason }, 403);
		if (error instanceof z.ZodError) return reply({ error: "Invalid request", reason: "invalid_request" }, 400);
		if (
			[
				"archived_classification",
				"principal_not_found",
				"name_conflict",
				"job_not_pending",
				"classification_pending_timeout",
				"classification_reversal_required",
			].includes(reason)
		)
			return reply({ error: reason }, 409);
		if (
			["invalid_cursor", "invalid_job", "too_many_principals", "unsupported_classification_operation"].includes(
				reason,
			) ||
			error instanceof SyntaxError
		)
			return reply(
				{ error: "Invalid request", reason: error instanceof SyntaxError ? "invalid_request" : reason },
				400,
			);
		throw error;
	});
	app.post("/api/classifications/jobs/:jobId/cancel", async (c) => {
		const principal = actor(c);
		if (!principal.canClassify) throw Error("permission");
		const input = {
			op: "cancel",
			actor: principal.actor,
			jobId: z.string().min(1).max(200).parse(c.req.param("jobId")),
		} as const;
		const receipt = z.object({ jobId: z.string(), status: z.string() }).parse(await request(input));
		if (c.req.query("wait") === "1") {
			await executeClassificationJob(receipt.jobId, request);
			return reply(await request(input));
		}
		void attemptAsync(() => executeClassificationJob(receipt.jobId, request));
		return reply(receipt, 202);
	});
	app.get("/api/classifications", async (c) => {
		const principal = actor(c);
		return reply(await request({ op: "list", actor: principal.actor, includePrincipals: principal.canClassify }));
	});
	app.get("/api/classifications/:id", async (c) => {
		const principal = actor(c);
		return reply(
			await request({
				op: "get",
				actor: principal.actor,
				id: c.req.param("id"),
				includePrincipals: principal.canClassify,
			}),
		);
	});
	app.post("/api/classifications", async (c) => {
		const principal = actor(c);
		if (!principal.canClassify) throw new Error("permission");
		const a = principal.actor,
			body = create.parse(await c.req.json());
		return reply(
			await request({
				op: "create",
				actor: a,
				name: body.name,
				color: body.color ?? null,
				description: body.description ?? null,
				audience: body.audience,
				appliers: body.appliers ?? [],
			}),
			201,
		);
	});
	app.patch("/api/classifications/:id", async (c) => {
		const principal = actor(c);
		if (!principal.canClassify) throw new Error("permission");
		const a = principal.actor,
			body = update.parse(await c.req.json());
		return reply(await request({ op: "update", actor: a, id: c.req.param("id"), ...body }));
	});
	for (const audienceOp of ["audience", "appliers"] as const)
		app.put(`/api/classifications/:id/${audienceOp}`, async (c) => {
			const principal = actor(c);
			if (!principal.canClassify) throw new Error("permission");
			const a = principal.actor,
				principals = z
					.array(person)
					.max(1000)
					.parse(await c.req.json());
			return reply(await request({ op: audienceOp, actor: a, id: c.req.param("id"), principals }));
		});
	app.post("/api/classifications/:id/preview", async (c) => {
		const a = actor(c),
			body = z
				.object({ target })
				.strict()
				.parse(await c.req.json());
		const scope = await resolveReadScope(
			{
				reach: a.actor.boundAgentId ? { kind: "own", agentId: a.actor.boundAgentId } : { kind: "all" },
				projects: a.projects,
			},
			a.actor,
			async (subject) => readVisibilitySchema.parse(await request({ op: "visibility", subject })),
		);
		return reply(await request({ op: "preview", actor: a.actor, id: c.req.param("id"), target: body.target, scope }));
	});
	for (const op of ["apply", "remove"] as const)
		app.post(`/api/classifications/:id/${op}`, async (c) => {
			const principal = actor(c);
			if (principal.actor.compliance && !principal.canClassify) throw new Error("permission");
			const a = { ...principal.actor, compliance: principal.actor.compliance && principal.canClassify },
				body = z
					.object({ target })
					.strict()
					.parse(await c.req.json());
			const job = z.object({ jobId: z.string() }).parse(
				await request({
					op: "enqueue",
					actor: a,
					id: c.req.param("id"),
					target: body.target,
					remove: op === "remove",
				}),
			);
			if (c.req.query("wait") === "1") await executeClassificationJob(job.jobId, request);
			else void attemptAsync(() => executeClassificationJob(job.jobId, request));
			return reply(job, 202);
		});
	app.get("/api/classifications/:id/items", async (c) => {
		const a = actor(c);
		const scope = await resolveReadScope(
			{
				reach: a.actor.boundAgentId ? { kind: "own", agentId: a.actor.boundAgentId } : { kind: "all" },
				projects: a.projects,
			},
			a.actor,
			async (subject) => readVisibilitySchema.parse(await request({ op: "visibility", subject })),
		);
		return reply(
			await request({
				op: "items",
				actor: a.actor,
				id: c.req.param("id"),
				cursor: c.req.query("cursor") ?? null,
				scope,
			}),
		);
	});
	parent.route("/", app);
}
