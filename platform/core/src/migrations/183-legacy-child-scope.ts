import { compartmentFor, syncEmbeddingCompartment } from "../compartment-shards";
import type { MigrationArtifacts, MigrationDb } from "./contract";

export const artifacts: MigrationArtifacts = {
	tables: ["legacy_child_scope_repairs"],
	columns: ["table_name", "examined", "repaired", "unresolved"].map((column) => ({
		table: "legacy_child_scope_repairs",
		column,
	})),
};

interface Parent {
	readonly table: string;
	readonly key: string;
	readonly reference: string;
	readonly when?: string;
}
interface Child {
	readonly table: string;
	readonly parents: readonly Parent[];
	readonly when?: string;
}
const children: readonly Child[] = [
	...(["embeddings", "embeddings_staging"] as const).flatMap((table) => [
		{ table, when: "child.source_type='memory'", parents: [{ table: "memories", key: "id", reference: "source_id" }] },
		{ table, when: "child.source_type='skill'", parents: [{ table: "entities", key: "id", reference: "source_id" }] },
	]),
	{ table: "memory_hints", parents: [{ table: "memories", key: "id", reference: "memory_id" }] },
	{ table: "memory_history", parents: [{ table: "memories", key: "id", reference: "memory_id" }] },
	{
		table: "memory_entity_mentions",
		parents: [
			{ table: "memories", key: "id", reference: "memory_id" },
			{ table: "entities", key: "id", reference: "entity_id" },
		],
	},
	{
		table: "relations",
		parents: [
			{ table: "entities", key: "id", reference: "source_entity_id" },
			{ table: "entities", key: "id", reference: "target_entity_id" },
		],
	},
	{
		table: "derived_memory_sources",
		parents: [
			{ table: "memories", key: "id", reference: "derived_memory_id" },
			{ table: "memories", key: "id", reference: "source_id", when: "source_kind='memory'" },
			{ table: "entity_attributes", key: "id", reference: "source_id", when: "source_kind='ontology_claim'" },
		],
	},
	...(["dreaming_tool_calls", "dreaming_history_nodes"] as const).map((table) => ({
		table,
		when: "child.pass_id IS NOT NULL",
		parents: [{ table: "dreaming_passes", key: "id", reference: "pass_id" }],
	})),
];

function columns(db: MigrationDb, table: string): Set<string> {
	return new Set(
		db
			.prepare(`PRAGMA table_info(${table})`)
			.all()
			.flatMap((row) => (typeof row.name === "string" ? [row.name] : [])),
	);
}

export function up(db: MigrationDb): void {
	db.exec(`CREATE TABLE IF NOT EXISTS legacy_child_scope_repairs (
		table_name TEXT PRIMARY KEY, examined INTEGER NOT NULL, repaired INTEGER NOT NULL, unresolved INTEGER NOT NULL
	)`);
	const schema = new Map<string, Set<string>>();
	const fields = (table: string): Set<string> => {
		let found = schema.get(table);
		if (!found) {
			found = columns(db, table);
			schema.set(table, found);
		}
		return found;
	};
	const totals = new Map<string, { examined: number; repaired: number; unresolved: number }>();
	for (const child of children) {
		const present = fields(child.table);
		if (!present.has("agent_id") || !present.has("compartment_id")) continue;
		if (child.when && [...child.when.matchAll(/child\.(\w+)/g)].some((match) => !present.has(match[1] ?? ""))) continue;
		if (child.parents.some((parent) => !present.has(parent.reference) || !fields(parent.table).has(parent.key)))
			continue;
		let cursor = 0;
		let examined = 0;
		let repaired = 0;
		let unresolved = 0;
		const references = [...new Set(child.parents.map((parent) => parent.reference))];
		const select =
			db.prepare(`SELECT child.rowid AS cursor,child.agent_id,child.compartment_id,${references.map((ref) => `child.${ref}`).join(",")}
			FROM ${child.table} child WHERE child.rowid>? AND (child.agent_id IS NULL OR child.agent_id='' OR child.compartment_id IS NULL) AND (${child.when ?? "1"}) ORDER BY child.rowid LIMIT 256`);
		for (;;) {
			const rows = select.all(cursor);
			if (rows.length === 0) break;
			for (const row of rows) {
				if (typeof row.cursor !== "number") throw new Error("legacy_scope_cursor_invalid");
				cursor = row.cursor;
				examined++;
				const parents = child.parents.flatMap((parent) => {
					if (parent.when && !db.prepare(`SELECT 1 FROM ${child.table} WHERE rowid=? AND ${parent.when}`).get(cursor))
						return [];
					const label = fields(parent.table).has("compartment_id") ? "compartment_id" : "NULL AS compartment_id";
					const owner = fields(parent.table).has("agent_id") ? "agent_id" : "NULL AS agent_id";
					const matches = db
						.prepare(`SELECT ${owner},${label} FROM ${parent.table} WHERE ${parent.key}=? LIMIT 2`)
						.all(row[parent.reference]);
					return matches.length === 1 ? matches : [{ agent_id: null, compartment_id: null }];
				});
				const agents = new Set(parents.map((parent) => parent.agent_id));
				const agent = parents[0]?.agent_id;
				if (
					parents.length === 0 ||
					agents.size !== 1 ||
					typeof agent !== "string" ||
					agent.length === 0 ||
					(typeof row.agent_id === "string" && row.agent_id.length > 0 && row.agent_id !== agent)
				) {
					unresolved++;
					continue;
				}
				const labels = [...parents, row]
					.filter((parent) => parent.compartment_id !== null && parent.compartment_id !== undefined)
					.flatMap((parent) =>
						db
							.prepare("SELECT classification_id FROM compartment_members WHERE compartment_id=?")
							.all(parent.compartment_id)
							.flatMap((member) => (typeof member.classification_id === "string" ? [member.classification_id] : [])),
					);
				const label = compartmentFor(db, labels);
				if (row.agent_id === agent && row.compartment_id === label) continue;
				db.prepare(`UPDATE ${child.table} SET agent_id=?,compartment_id=? WHERE rowid=?`).run(agent, label, cursor);
				if ((child.table === "embeddings" || child.table === "embeddings_staging") && row.compartment_id !== label) {
					const id = db.prepare(`SELECT id FROM ${child.table} WHERE rowid=?`).get(cursor)?.id;
					if (typeof id === "string") syncEmbeddingCompartment(db, child.table, id);
				}
				repaired++;
			}
		}
		const previous = totals.get(child.table) ?? { examined: 0, repaired: 0, unresolved: 0 };
		totals.set(child.table, {
			examined: previous.examined + examined,
			repaired: previous.repaired + repaired,
			unresolved: previous.unresolved + unresolved,
		});
	}
	for (const [table, counts] of totals) {
		db.prepare(`INSERT INTO legacy_child_scope_repairs(table_name,examined,repaired,unresolved) VALUES(?,?,?,?)
			ON CONFLICT(table_name) DO UPDATE SET examined=excluded.examined,repaired=legacy_child_scope_repairs.repaired+excluded.repaired,unresolved=excluded.unresolved`).run(
			table,
			counts.examined,
			counts.repaired,
			counts.unresolved,
		);
	}
}
