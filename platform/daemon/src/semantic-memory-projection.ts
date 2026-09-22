import type { WriteDb } from "./db-accessor";
import { txForgetMemory } from "./transactions";
export function purgeAttributeMemoryProjectionsInTx(
	db: WriteDb,
	input: {
		readonly sourceId: string;
		readonly agentId?: string;
		readonly sourcePath?: string;
		readonly sourceRoot?: string;
	},
): number {
	const filters = ["source_id = ?", "memory_id IS NOT NULL"];
	const args: string[] = [input.sourceId];
	if (input.agentId) {
		filters.push("agent_id = ?");
		args.push(input.agentId);
	}
	if (input.sourcePath) {
		filters.push("source_path = ?");
		args.push(input.sourcePath);
	}
	if (input.sourceRoot) {
		filters.push("source_root = ?");
		args.push(input.sourceRoot);
	}
	const rows = db
		.prepare(
			`SELECT DISTINCT attr.memory_id, attr.agent_id AS attribute_agent_id, mem.agent_id AS memory_agent_id
			 FROM entity_attributes attr
			 LEFT JOIN memories mem ON mem.id = attr.memory_id
			 WHERE ${filters.map((filter) => `attr.${filter}`).join(" AND ")}`,
		)
		.all(...args) as Array<{
		memory_id: string;
		attribute_agent_id: string;
		memory_agent_id: string | null;
	}>;
	const changedAt = new Date().toISOString();
	let purged = 0;
	for (const row of rows) {
		if (row.memory_agent_id !== null && row.memory_agent_id !== row.attribute_agent_id) {
			throw new Error("Refusing to purge a semantic memory projection across agent scopes");
		}
		const result = txForgetMemory(db, {
			memoryId: row.memory_id,
			reason: "Source disconnected",
			changedBy: "source-purge",
			changedAt,
			force: true,
		});
		if (result.status === "deleted") purged++;
		if (result.status !== "deleted" && result.status !== "already_deleted" && result.status !== "not_found") {
			throw new Error(`Could not purge semantic memory projection: ${result.status}`);
		}
	}
	return purged;
}
