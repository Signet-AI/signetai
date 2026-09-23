import { createHash } from "node:crypto";
import { Database } from "bun:sqlite";

function identifier(name: string): string {
	return `"${name.replaceAll('"', '""')}"`;
}

function tableNames(db: Database): string[] {
	return db
		.query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
		.all()
		.map((row) => String((row as { name: string }).name));
}

function rowDigest(db: Database, name: string): { count: number; hash: string } {
	const quoted = identifier(name);
	const keys = (db.query(`PRAGMA table_info(${quoted})`).all() as { name: string; pk: number }[])
		.filter((column) => column.pk > 0)
		.sort((a, b) => a.pk - b.pk)
		.map((column) => identifier(column.name));
	const order = keys.length ? keys.join(", ") : "rowid";
	const hash = createHash("sha256");
	let count = 0;
	for (const row of db.query(`SELECT * FROM ${quoted} ORDER BY ${order}`).iterate() as Iterable<
		Record<string, unknown>
	>) {
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
	const source = new Database(sourcePath, { readonly: true });
	try {
		const destination = new Database(destinationPath, { readonly: true });
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
