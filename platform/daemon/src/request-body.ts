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
export function streamedRequestBody(c: Context): boolean {
	return (
		(c.req.method === "PUT" && /^\/api\/sources\/imports\/[^/]+\/files\/[^/]+$/.test(c.req.path)) ||
		(c.req.method === "POST" &&
			c.req.path === "/api/sources/import" &&
			c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() === "multipart/form-data") ||
		c.req.path === "/mcp"
	);
}
export async function prepareJsonBody(c: Context): Promise<void> {
	if (c.get("jsonBodyParsed") || streamedRequestBody(c) || !["POST", "PUT", "PATCH", "DELETE"].includes(c.req.method))
		return;
	const text = await c.req.text();
	const api = c.req.path.startsWith("/api/") || c.req.path.startsWith("/memory/");
	const json = c.req.header("content-type")?.split(";")[0]?.trim().toLowerCase() === "application/json";
	if (text.length && api && !json) throw new JsonBodyError(415, "unsupported_media_type");
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
