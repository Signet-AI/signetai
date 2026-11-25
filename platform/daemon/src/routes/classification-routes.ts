import { attemptAsync } from "@signet/core";
import { Hono, type Context } from "hono";
import { z } from "zod";
import { resolveReadScope } from "../read-scope";
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
	credential: z.object({ kind: z.string(), id: z.string() }),
	allowedProjects: z.array(z.string()).nullable(),
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
	const actor = (c: Context): { actor: ClassificationActor; projects: readonly string[] | null } => {
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
				userId: p.userId,
				groupIds: p.groupIds,
				local: p.kind === "local",
				compliance: p.compliance,
				credential: `${p.credential.kind}:${p.credential.id}`,
			},
			projects: p.allowedProjects,
		};
	};
	app.onError((error, _c) => {
		const reason = error.message;
		if (reason === "not_found") return reply({ error: "Not found" }, 404);
		if (reason === "unauthorized") return reply({ error: "Unauthorized", reason: "missing_credential" }, 401);
		if (reason === "permission" || reason === "not_owner") return reply({ error: "Forbidden", reason }, 403);
		if (error instanceof z.ZodError) return reply({ error: "Invalid request", reason: "invalid_request" }, 400);
		if (reason === "archived_classification" || reason === "principal_not_found") return reply({ error: reason }, 409);
		throw error;
	});
	app.get("/api/classifications", async (c) => reply(await request({ op: "list", actor: actor(c).actor })));
	app.get("/api/classifications/:id", async (c) =>
		reply(await request({ op: "get", actor: actor(c).actor, id: c.req.param("id") })),
	);
	app.post("/api/classifications", async (c) => {
		const a = actor(c).actor,
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
		const a = actor(c).actor,
			body = update.parse(await c.req.json());
		return reply(await request({ op: "update", actor: a, id: c.req.param("id"), ...body }));
	});
	for (const op of ["audience", "appliers"] as const)
		app.put(`/api/classifications/:id/${op}`, async (c) => {
			const a = actor(c).actor,
				principals = z
					.array(person)
					.max(1000)
					.parse(await c.req.json());
			return reply(await request({ op, actor: a, id: c.req.param("id"), principals }));
		});
	app.post("/api/classifications/:id/preview", async (c) => {
		const a = actor(c),
			body = z
				.object({ target })
				.strict()
				.parse(await c.req.json());
		const scope = await resolveReadScope({ reach: { kind: "all" }, projects: a.projects }, a.actor, async (subject) =>
			z
				.union([z.literal("all"), z.array(z.number().int().positive())])
				.parse(await request({ op: "readable", subject })),
		);
		return reply(await request({ op: "preview", actor: a.actor, id: c.req.param("id"), target: body.target, scope }));
	});
	for (const op of ["apply", "remove"] as const)
		app.post(`/api/classifications/:id/${op}`, async (c) => {
			const a = actor(c).actor,
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
		const scope = await resolveReadScope({ reach: { kind: "all" }, projects: a.projects }, a.actor, async (subject) =>
			z
				.union([z.literal("all"), z.array(z.number().int().positive())])
				.parse(await request({ op: "readable", subject })),
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
