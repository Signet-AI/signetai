import type { Database, SQLQueryBindings } from "bun:sqlite";
import type { MigrationDb } from "@signet/core";

function binding(value: unknown): SQLQueryBindings {
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
function bindings(values: readonly unknown[]): SQLQueryBindings[] {
	return values.map(binding);
}

function namedBindings(values: readonly unknown[]): Record<string, SQLQueryBindings> | undefined {
	const value = values[0];
	if (values.length !== 1 || typeof value !== "object" || value === null || ArrayBuffer.isView(value)) return undefined;
	const named: Record<string, SQLQueryBindings> = {};
	for (const [key, nested] of Object.entries(value)) named[key] = binding(nested);
	return named;
}

export function migrationFixtureDb(db: Database): MigrationDb {
	return {
		exec: (sql) => {
			db.exec(sql);
		},
		prepare: (sql) => {
			const positional = db.prepare<Record<string, unknown>, SQLQueryBindings[]>(sql);
			const named = db.prepare<Record<string, unknown>, Record<string, SQLQueryBindings>>(sql);
			return {
				run: (...values) => {
					const params = namedBindings(values);
					return params ? named.run(params) : positional.run(...bindings(values));
				},
				get: (...values) => {
					const params = namedBindings(values);
					return (params ? named.get(params) : positional.get(...bindings(values))) ?? undefined;
				},
				all: (...values) => {
					const params = namedBindings(values);
					return params ? named.all(params) : positional.all(...bindings(values));
				},
			};
		},
	};
}
