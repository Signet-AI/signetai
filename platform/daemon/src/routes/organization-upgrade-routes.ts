import type { Context, Hono, MiddlewareHandler } from "hono";
import { requireUser } from "../auth/organization-operations";
import { jsonBody } from "../request-body";
import {
	controlOrganizationUpgrade,
	organizationUpgrade,
	previewOrganizationUpgrade,
	reviseOrganizationUpgrade,
} from "../organization-upgrade";

export function registerOrganizationUpgradeRoutes(
	app: Hono,
	active: (fn: (c: Context) => Promise<Response>) => MiddlewareHandler,
): void {
	const actor = (c: Context) => requireUser(c.get("principal"));
	app.get(
		"/api/org/upgrade",
		active(async (c) => c.json(await organizationUpgrade(actor(c), { action: "inventory" }))),
	);
	app.post(
		"/api/org/upgrade/preview",
		active(async (c) => c.json(await previewOrganizationUpgrade(actor(c), await jsonBody(c)()), 201)),
	);
	app.get(
		"/api/org/upgrade/:id",
		active(async (c) =>
			c.json(await organizationUpgrade(actor(c), { action: "read", jobId: c.req.param("id") ?? "" })),
		),
	);
	app.put(
		"/api/org/upgrade/:id",
		active(async (c) =>
			c.json(await reviseOrganizationUpgrade(actor(c), c.req.param("id") ?? "", await jsonBody(c)())),
		),
	);
	for (const action of ["confirm", "cancel", "resume"] as const)
		app.post(
			`/api/org/upgrade/:id/${action}`,
			active(async (c) =>
				c.json(
					await controlOrganizationUpgrade(actor(c), c.req.param("id") ?? "", action, await jsonBody(c)()),
					action === "cancel" ? 200 : 202,
				),
			),
		);
}
