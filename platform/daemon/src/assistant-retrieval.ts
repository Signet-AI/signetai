import type { AssistantChatEvent } from "@signet/core";

export function retrievalEvent(tool: string, output: unknown): AssistantChatEvent | undefined {
	if (
		!["search_entities", "get_entity", "list_aspect_claims", "walk_links", "get_evidence", "search_evidence"].includes(
			tool,
		)
	)
		return;
	if (typeof output !== "object" || output === null || !("ok" in output) || output.ok !== true) return;
	const nodeIds = new Set<string>();
	const evidenceRefs = new Set<string>();
	let remaining = 600;
	const add = (set: Set<string>, value: unknown, prefix = "") => {
		if (typeof value === "string" && value.length > 0 && prefix.length + value.length <= 512 && set.size < 100)
			set.add(prefix + value);
	};
	const visit = (value: unknown, depth: number) => {
		if (--remaining < 0 || depth > 6 || typeof value !== "object" || value === null) return;
		if (Array.isArray(value)) {
			for (const item of value.slice(0, 100)) visit(item, depth + 1);
			return;
		}
		if ("id" in value && !("kind" in value && value.kind === "artifact")) add(nodeIds, value.id);
		if ("entityId" in value) add(nodeIds, value.entityId);
		if ("aspectId" in value) add(nodeIds, value.aspectId);
		if ("sourceEntityId" in value) add(nodeIds, value.sourceEntityId);
		if ("targetEntityId" in value) add(nodeIds, value.targetEntityId);
		if ("memoryId" in value) add(evidenceRefs, value.memoryId, "memory:");
		if ("sourceRef" in value) add(evidenceRefs, value.sourceRef);
		if ("sourceId" in value) add(evidenceRefs, value.sourceId, "source:");
		for (const key of ["items", "result", "entity", "aspects", "attribute", "evidence", "sources", "links"]) {
			if (key in value) visit(Reflect.get(value, key), depth + 1);
		}
	};
	visit(output, 0);
	if (nodeIds.size || evidenceRefs.size)
		return { type: "retrieval", nodeIds: [...nodeIds], evidenceRefs: [...evidenceRefs] };
}
