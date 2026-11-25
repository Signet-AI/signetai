import { registerPublicReadResponse, publicReadValue } from "../public-read-response";
import type { Hono } from "hono";
import { requirePermission } from "../auth";
import type { DbAccessor } from "../db-accessor";
import { readDatabaseSchemaAsync, readTableSampleAsync } from "../diagnostics";
import { resolveRouteReadScope } from "./read-scope";
import { authConfig } from "./state";
import { parseBoundedInt } from "./utils";
export { readDatabaseSchemaAsync, readTableSampleAsync } from "../diagnostics";
export type {
	DatabaseSchemaGroup,
	DatabaseColumnInfo,
	DatabaseIndexColumnInfo,
	DatabaseIndexInfo,
	DatabaseForeignKeyInfo,
	DatabaseTableInfo,
	DatabaseSchemaResponse,
	DatabaseTableSampleResponse,
} from "../diagnostics";

export function registerDatabaseDiagnosticsRoutes(app: Hono, deps?: { readonly accessor?: DbAccessor }): void {
	registerPublicReadResponse(app, "/api/diagnostics/database/*");
	const accessor = () => deps?.accessor;

	app.use("/api/diagnostics/database", async (c, next) => requirePermission("diagnostics", authConfig)(c, next));
	app.use("/api/diagnostics/database/*", async (c, next) => requirePermission("diagnostics", authConfig)(c, next));

	app.get("/api/diagnostics/database/schema", async (c) =>
		c.json(
			await readDatabaseSchemaAsync(
				accessor(),
				c.get("principal")?.kind === "local" || (!c.get("organization") && !c.get("auth")?.claims)
					? undefined
					: await resolveRouteReadScope(c),
			),
		),
	);

	app.get("/api/diagnostics/database/tables/:table/sample", async (c) => {
		const result = await readTableSampleAsync(
			accessor(),
			c.req.param("table"),
			parseBoundedInt(c.req.query("limit"), 25, 1, 100),
			parseBoundedInt(c.req.query("offset"), 0, 0, Number.MAX_SAFE_INTEGER),
			c.get("principal")?.kind === "local" || (!c.get("organization") && !c.get("auth")?.claims)
				? undefined
				: await resolveRouteReadScope(c),
		);
		if ("status" in result) return c.json({ error: result.error }, result.status);
		return c.json(result);
	});
}
