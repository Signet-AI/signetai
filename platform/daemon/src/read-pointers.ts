import type { MiddlewareHandler } from "hono";
import { contentRead } from "./content-read";
import type { ReadScope } from "./read-scope";
declare module "hono" {
	interface ContextVariableMap {
		readResponseScope: ReadScope;
		readPointersRedacted: boolean;
	}
}

type Reference = { kind: "memory" | "session" | "summary" | "artifact" | "document"; id: string };
const memoryKeys = new Set([
	"supersededBy",
	"superseded_by",
	"supersedes",
	"memoryId",
	"memory_id",
	"parentId",
	"parent_id",
	"childId",
	"child_id",
	"linkedMemoryId",
	"parentMemoryId",
	"derivedMemoryId",
	"derivedSourceId",
	"source_memory_id",
	"target_memory_id",
	"derivedFrom",
	"derived_from",
]);
const sessionKeys = new Set(["sessionId", "session_id", "sessionKey", "session_key"]);
function reference(key: string, value: unknown, record: Record<string, unknown>): Reference | null {
	if (typeof value !== "string" || !value) return null;
	if ((key === "source_id" || key === "sourceId") && ("source_path" in record || "sourcePath" in record)) return null;
	if (
		sessionKeys.has(key) &&
		("agent_id" in record || "agentId" in record) &&
		("digest" in record ||
			"depth" in record ||
			"memories_recalled" in record ||
			"speakerUserId" in record ||
			record.id === value)
	)
		return null;
	if (memoryKeys.has(key)) return { kind: "memory", id: value };
	if (key === "source_node_id" || key === "sourceNodeId") return { kind: "summary", id: value };
	if (sessionKeys.has(key)) return { kind: "session", id: value };
	if (["sourceRef", "source_ref"].includes(key)) {
		for (const kind of ["memory", "session", "summary", "artifact", "document"] as const)
			if (value.startsWith(`${kind}:`)) return { kind, id: value.slice(kind.length + 1) };
	}
	if (["sourceId", "source_id"].includes(key)) {
		const type = record.sourceType ?? record.source_type;
		if (typeof type === "string" && type.startsWith("session")) return { kind: "session", id: value };
		if (type === "memory" || type === "aggregate-recall") return { kind: "memory", id: value };
		if (type === "document") return { kind: "document", id: value };
	}
	return null;
}
export async function redactReadPointers(value: unknown, scope: ReadScope): Promise<unknown> {
	const refs = new Map<string, Reference>();
	const collect = (node: unknown, depth: number): void => {
		if (depth > 32) throw new Error("Pointer nesting limit exceeded");
		if (Array.isArray(node)) {
			for (const item of node) collect(item, depth + 1);
			return;
		}
		if (node === null || typeof node !== "object") return;
		const record = Object.fromEntries(Object.entries(node));
		for (const [key, item] of Object.entries(record)) {
			const ref = reference(key, item, record);
			if (ref) refs.set(`${ref.kind}:${ref.id}`, ref);
			else collect(item, depth + 1);
		}
	};
	collect(value, 0);
	if (refs.size > 20000) throw new Error("Pointer admission limit exceeded");
	const allowed = new Set<string>();
	const references = [...refs.values()];
	for (let offset = 0; offset < references.length; offset += 500) {
		for (const key of await contentRead<string[]>({
			op: "readable_pointers",
			scope,
			references: references.slice(offset, offset + 500),
		}))
			allowed.add(key);
	}

	const apply = (node: unknown): unknown => {
		if (Array.isArray(node)) return node.map(apply);
		if (node === null || typeof node !== "object") return node;
		const record = Object.fromEntries(Object.entries(node));
		const result = Object.fromEntries(
			Object.entries(record)
				.filter(
					([key]) =>
						![
							"compartment_id",
							"content_hash",
							"normalized_content",
							"vector_clock",
							"idempotency_key",
							"idempotencyKey",
							"rowid",
							"author_user_id",
							"speaker_user_id",
						].includes(key),
				)
				.map(([key, item]) => {
					const ref = reference(key, item, record);
					return [key, ref && !allowed.has(`${ref.kind}:${ref.id}`) ? null : apply(item)];
				}),
		);
		if (
			("superseded_by" in result && result.superseded_by === null) ||
			("supersededBy" in result && result.supersededBy === null)
		)
			for (const key of ["superseded_at", "superseded_reason", "supersededAt", "supersededReason"])
				if (key in result) result[key] = null;
		return result;
	};
	return apply(value);
}

export const readPointerMiddleware: MiddlewareHandler = async (c, next) => {
	await next();
	const scope = c.get("readResponseScope");
	if (
		c.req.method !== "GET" ||
		!scope ||
		c.get("readPointersRedacted") ||
		!c.res.ok ||
		!c.res.headers.get("content-type")?.includes("application/json")
	)
		return;
	const value: unknown = await c.res.json();
	const result = await redactReadPointers(value, scope);
	const headers = new Headers(c.res.headers);
	headers.delete("content-length");
	c.res = new Response(JSON.stringify(result), { status: c.res.status, headers });
	c.set("readPointersRedacted", true);
};
