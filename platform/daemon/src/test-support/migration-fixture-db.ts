import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { MigrationDb } from "@signet/core";

function bindings(values: readonly unknown[]): SQLQueryBindings[] {
	return values.map((value): SQLQueryBindings => {
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
	});
}

export function migrationFixtureDb(db: Database): MigrationDb {
	return {
		exec: (sql) => {
			db.exec(sql);
		},
		prepare: (sql) => {
			const statement = db.prepare<Record<string, unknown>, SQLQueryBindings[]>(sql);
			return {
				run: (...values) => statement.run(...bindings(values)),
				get: (...values) => statement.get(...bindings(values)) ?? undefined,
				all: (...values) => statement.all(...bindings(values)),
			};
		},
	};
}
