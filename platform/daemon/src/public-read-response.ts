import type { Hono } from "hono";

export type PublicReadJson = null | string | number | boolean | PublicReadJson[] | { [key: string]: PublicReadJson };
const internalFields = new Set([
	"compartment_id",
	"compartmentId",
	"content_hash",
	"contentHash",
	"normalized_content",
	"normalizedContent",
	"vector_clock",
	"vectorClock",
	"idempotency_key",
	"idempotencyKey",
	"rowid",
]);

export function isPublicReadField(key: string): boolean {
	return !internalFields.has(key);
}

export function publicReadValue(value: unknown, organizationMode = true): PublicReadJson {
	if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean")
		return value;
	if (Array.isArray(value)) return value.map((item) => publicReadValue(item, organizationMode));
	if (typeof value !== "object") return null;
	return Object.fromEntries(
		Object.entries(value)
			.filter(
				([key, item]) => !organizationMode || (isPublicReadField(key) && !(key === "id" && typeof item === "number")),
			)
			.map(([key, item]) => [key, publicReadValue(item, organizationMode)]),
	);
}

export function registerPublicReadResponse(app: Hono, path: string): void {
	app.use(path, async (c, next) => {
		await next();
		if (!c.get("organization")) return;
		const response = c.res;
		if (
			!response.headers.get("content-type")?.includes("application/json") ||
			response.status === 204 ||
			response.status === 304
		)
			return;
		const body = publicReadValue(await response.clone().json());
		const headers = new Headers(response.headers);
		headers.delete("content-length");
		c.res = new Response(JSON.stringify(body), { status: response.status, headers });
	});
}
