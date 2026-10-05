import { expect, test } from "bun:test";
import { retrievalEvent } from "./assistant-retrieval";
import { parseAssistantChatEvent } from "../../core/src/assistant-chat";

test("retrieval reports only successful reads with bounded stable references", () => {
	expect(retrievalEvent("search_entities", { ok: true, items: [{ id: "entity-1", name: "same name" }] })).toEqual({
		type: "retrieval",
		nodeIds: ["entity-1"],
		evidenceRefs: [],
	});
	expect(retrievalEvent("get_evidence", { ok: true, items: [{ id: "retired-tool" }] })).toBeUndefined();
	expect(
		retrievalEvent("search_evidence", { ok: true, items: [{ sourceRef: "artifact:a", sourceId: "import:one" }] }),
	).toEqual({ type: "retrieval", nodeIds: [], evidenceRefs: ["artifact:a", "source:import:one"] });
	expect(retrievalEvent("remember_context", { ok: true, items: [{ id: "private" }] })).toBeUndefined();
	expect(retrievalEvent("search_entities", { ok: false, items: [{ id: "private" }] })).toBeUndefined();
});

test("retrieval events bound large results and reject invalid wire identifiers", () => {
	const event = retrievalEvent("search_entities", {
		ok: true,
		items: Array.from({ length: 1000 }, (_, i) => ({ id: String(i) })),
	});
	expect(event?.type).toBe("retrieval");
	if (event?.type === "retrieval") expect(event.nodeIds).toHaveLength(100);
	expect(() => parseAssistantChatEvent({ type: "retrieval", nodeIds: [42], evidenceRefs: [] })).toThrow();
	expect(() =>
		parseAssistantChatEvent({ type: "retrieval", nodeIds: Array(101).fill("id"), evidenceRefs: [] }),
	).toThrow();
	expect(parseAssistantChatEvent({ type: "retrieval", nodeIds: ["entity"], evidenceRefs: ["memory:m"] })).toEqual({
		type: "retrieval",
		nodeIds: ["entity"],
		evidenceRefs: ["memory:m"],
	});
});

test("imported artifact retrieval preserves its canonical artifact reference despite a shared bridge identity", () => {
	const artifactPath = "imports/import:people/Buse.md";
	const event = retrievalEvent("search_evidence", {
		ok: true,
		items: [
			{
				kind: "artifact",
				id: artifactPath,
				sourceRef: `artifact:${artifactPath}`,
				sourceId: "native-memory-bridge",
				sourceEntryId: "import:people",
				sourcePath: artifactPath,
			},
		],
	});
	expect(event).toEqual({
		type: "retrieval",
		nodeIds: [],
		evidenceRefs: [`artifact:${artifactPath}`, "source:native-memory-bridge"],
	});
	expect(
		retrievalEvent("search_evidence", {
			ok: true,
			items: [{ kind: "artifact", id: artifactPath, sourceRef: `artifact:${artifactPath}`, sourceId: null }],
		}),
	).toEqual({ type: "retrieval", nodeIds: [], evidenceRefs: [`artifact:${artifactPath}`] });
});
