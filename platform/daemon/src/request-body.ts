import type { Context } from "hono";

declare module "hono" {
	interface ContextVariableMap {
		parsedJsonBody: unknown;
		jsonBodyParsed: boolean;
	}
}
export class JsonBodyError extends Error {
	constructor(
		readonly status: 400 | 415,
		readonly reason: string,
	) {
		super(reason);
	}
}
export const RAW_BODY_ROUTES = [
	{ method: "PUT", path: "/api/sources/imports/:jobId/files/:fileId" },
	{ method: "PATCH", path: "/api/sources/imports/:jobId/files/:fileId" },
	{ method: "POST", path: "/api/sources/import", contentType: "multipart/form-data" },
	{ method: "ALL", path: "/mcp" },
] as const;
export function streamedRequestBody(c: Context): boolean {
	return RAW_BODY_ROUTES.some(
		(route) =>
			(route.method === "ALL" || route.method === c.req.method) &&
			route.path.split("/").length === c.req.path.split("/").length &&
			route.path
				.split("/")
				.every((part, i) =>
					part.startsWith(":") ? Boolean(c.req.path.split("/")[i]) : part === c.req.path.split("/")[i],
				) &&
			(!("contentType" in route) ||
				route.contentType === c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase()),
	);
}
export async function prepareJsonBody(c: Context): Promise<void> {
	if (c.get("jsonBodyParsed") || streamedRequestBody(c) || !["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method))
		return;
	const text = await c.req.text();
	const json = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";
	if (text.length && !json) throw new JsonBodyError(415, "unsupported_media_type");
	if (!json && text.length) return;
	let parsed: unknown = {};
	if (text.length) {
		try {
			parsed = JSON.parse(text);
		} catch {
			throw new JsonBodyError(400, "invalid_request");
		}
	}
	c.set("parsedJsonBody", parsed);
	c.set("jsonBodyParsed", true);
}
export function jsonBody(c: Context) {
	function read<T = Record<string, unknown>>(): Promise<T>;
	async function read(): Promise<unknown> {
		await prepareJsonBody(c);
		if (c.get("jsonBodyParsed")) return c.get("parsedJsonBody");
		const text = await c.req.text();
		const parsed: unknown = text.length ? JSON.parse(text) : {};
		c.set("parsedJsonBody", parsed);
		c.set("jsonBodyParsed", true);
		return parsed;
	}
	return read;
}
