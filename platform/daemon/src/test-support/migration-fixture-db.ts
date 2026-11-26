import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { MigrationDb } from "@signet/core";

type ScalarBinding = string | number | boolean | bigint | null | Uint8Array | Float32Array;

function scalarBinding(value: unknown): ScalarBinding {
	if (value === null) return null;
	if (
		typeof value === "string" ||
		typeof value === "number" ||
		typeof value === "boolean" ||
		typeof value === "bigint" ||
		value instanceof Uint8Array ||
		value instanceof Float32Array
	)
		return value;
	throw new Error("Invalid migration fixture binding");
}

function binding(value: unknown): SQLQueryBindings {
	if (typeof value !== "object" || value === null || ArrayBuffer.isView(value)) return scalarBinding(value);
	const named: Record<string, ScalarBinding> = {};
	for (const [key, nested] of Object.entries(value)) named[key] = scalarBinding(nested);
	return named;
}

export function migrationFixtureDb(db: Database): MigrationDb {
	return {
		exec: (sql) => {
			db.exec(sql);
		},
		prepare: (sql) => {
			const statement = db.prepare<Record<string, unknown>, SQLQueryBindings[]>(sql);
			return {
				run: (...values) => statement.run(...values.map(binding)),
				get: (...values) => statement.get(...values.map(binding)) ?? undefined,
				all: (...values) => statement.all(...values.map(binding)),
			};
		},
	};
}
