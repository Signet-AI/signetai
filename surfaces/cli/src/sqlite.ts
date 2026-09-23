import { createHash } from "node:crypto";

interface SQLiteDatabase {
	pragma(pragma: string): void;
	exec(sql: string): void;
	prepare(sql: string): {
		run(...args: unknown[]): void;
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
		iterate(...args: unknown[]): Iterable<Record<string, unknown>>;
	};
	close(): void;
}
const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";
const createDatabase = (dbPath: string, options?: { readonly?: boolean }): SQLiteDatabase => {
	if (isBun) {
		const { Database } = require("bun:sqlite");
		return new Database(dbPath, options);
	} else {
		const BetterSqlite3 = require("better-sqlite3");
		return new BetterSqlite3(dbPath, options);
	}
};

function identifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function tableNames(db: SQLiteDatabase): string[] {
	return db
		.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.all()
		.map((row) => String(row.name));
}

function rowDigest(db: SQLiteDatabase, name: string): { count: number; hash: string } {
	const quoted = identifier(name);
	const keys = (db.prepare(`PRAGMA table_info(${quoted})`).all() as { name: string; pk: number }[])
		.filter((column) => column.pk > 0)
		.sort((a, b) => a.pk - b.pk)
		.map((column) => identifier(column.name));
	const order = keys.length ? keys.join(", ") : "rowid";
	const hash = createHash("sha256");
	let count = 0;
	for (const row of db.prepare(`SELECT * FROM ${quoted} ORDER BY ${order}`).iterate()) {
		const values = Object.entries(row).map(([column, value]) => [
			column,
			value instanceof Uint8Array
				? ["blob", Buffer.from(value).toString("hex")]
				: typeof value === "bigint"
					? ["integer", value.toString()]
					: [typeof value, value],
		]);
		const encoded = JSON.stringify(values);
		hash.update(`${Buffer.byteLength(encoded)}:`);
		hash.update(encoded);
		count++;
	}
	return { count, hash: hash.digest("hex") };
}

export function verifyMigrationDatabaseRows(sourcePath: string, destinationPath: string): void {
	const source = createDatabase(sourcePath, { readonly: true });
	try {
		const destination = createDatabase(destinationPath, { readonly: true });
		try {
			const sourceTables = tableNames(source);
			const destinationTables = tableNames(destination);
			if (JSON.stringify(sourceTables) !== JSON.stringify(destinationTables))
				throw new Error("migration database table inventory differs");
			for (const table of sourceTables) {
				const expected = rowDigest(source, table);
				const observed = rowDigest(destination, table);
				if (expected.count !== observed.count || expected.hash !== observed.hash)
					throw new Error(`migration database semantic mismatch: ${table}`);
			}
		} finally {
			destination.close();
		}
	} finally {
		source.close();
	}
}

export { createDatabase };
export default createDatabase;
