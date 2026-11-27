import type { MiddlewareHandler } from "hono";
import { contentRead } from "./content-read";
import type { ReadScope } from "./read-scope";
declare module "hono" {
	interface ContextVariableMap {
		readResponseScope: ReadScope;
		readPointersRedacted: boolean;
	}
}

type Reference = { kind: "memory" | "memory_value" | "session" | "summary" | "artifact" | "document"; id: string };
const memoryKeys = new Set([
	"supersededBy",
	"previousSupersededBy",
	"duplicateOf",
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
	if ((key === "source_id" || key === "sourceId") && ("source_kind" in record || "sourceKind" in record)) return null;
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
export async function redactReadPointers(value: unknown, scope: ReadScope, organizationMode = true): Promise<unknown> {
	const refs = new Map<string, Reference>();
	const collect = (node: unknown, depth: number, metadata = false): void => {
		if (depth > 32) throw new Error("Pointer nesting limit exceeded");
		if (metadata && typeof node === "string") {
			refs.set(`memory_value:${node}`, { kind: "memory_value", id: node });
			return;
		}
		if (Array.isArray(node)) {
			for (const item of node) collect(item, depth + 1, metadata);
			return;
		}
		if (node === null || typeof node !== "object") return;
		const record = Object.fromEntries(Object.entries(node));
		for (const [key, item] of Object.entries(record)) {
			const ref = reference(key, item, record);
			if (ref) refs.set(`${ref.kind}:${ref.id}`, ref);
			collect(item, depth + 1, metadata || key === "metadata");
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

	const apply = (node: unknown, metadata = false): { value: unknown; redacted: boolean } => {
		if (metadata && typeof node === "string" && !allowed.has(`memory_value:${node}`))
			return { value: null, redacted: true };
		if (Array.isArray(node)) {
			const children = node.map((child) => apply(child, metadata));
			return { value: children.map((child) => child.value), redacted: children.some((child) => child.redacted) };
		}
		if (node === null || typeof node !== "object") return { value: node, redacted: false };
		const record = Object.fromEntries(Object.entries(node));
		let redacted = false;
		const result: Record<string, unknown> = {};
		for (const [key, item] of Object.entries(record)) {
			if (
				organizationMode &&
				[
					"compartment_id",
					"content_hash",
					"normalized_content",
					"vector_clock",
					"idempotency_key",
					"idempotencyKey",
					"rowid",
					"author_user_id",
					"speaker_user_id",
				].includes(key)
			)
				continue;
			const ref = reference(key, item, record);
			if (ref && !allowed.has(`${ref.kind}:${ref.id}`)) {
				result[key] = null;
				redacted = true;
			} else {
				const child = apply(item, metadata || key === "metadata");
				result[key] = child.value;
				redacted ||= child.redacted;
			}
		}
		if (redacted && "reason" in result) result.reason = null;
		if (
			("superseded_by" in result && result.superseded_by === null) ||
			("supersededBy" in result && result.supersededBy === null)
		)
			for (const key of ["superseded_at", "superseded_reason", "supersededAt", "supersededReason"])
				if (key in result) result[key] = null;
		return { value: result, redacted };
	};
	return apply(value).value;
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
	const result = await redactReadPointers(value, scope, Boolean(c.get("organization")));
	const headers = new Headers(c.res.headers);
	headers.delete("content-length");
	c.res = new Response(JSON.stringify(result), { status: c.res.status, headers });
	c.set("readPointersRedacted", true);
};
