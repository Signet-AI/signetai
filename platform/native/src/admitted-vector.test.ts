import { Database } from "bun:sqlite";
import { expect, test } from "bun:test";
import * as native from "../index.js";
import { findSqliteVecExtension } from "../../core/src/database";

test("one admitted native scan applies eligibility before bounded exact top-k", () => {
	const scan: unknown = Reflect.get(native, "scanAdmittedVectors");
	expect(typeof scan).toBe("function");
	if (typeof scan !== "function") throw new Error("native admitted scan missing");
	const db = new Database(":memory:");
	try {
		const extension = findSqliteVecExtension();
		if (!extension) throw new Error("sqlite-vec required");
		db.loadExtension(extension);
		db.exec("CREATE VIRTUAL TABLE oracle USING vec0(id INTEGER PRIMARY KEY,embedding FLOAT[3] distance_metric=cosine)");
		const chunks: Array<{ vectors: Buffer; rowids: Buffer; validity: Buffer; eligibility: Buffer }> = [];
		const eligibleIds: number[] = [];
		for (let chunk = 0; chunk < 2; chunk++) {
			const vectors = Buffer.alloc(16 * 3 * 4);
			const rowids = Buffer.alloc(16 * 8);
			const eligibility = Buffer.alloc(2);
			for (let offset = 0; offset < 16; offset++) {
				const id = chunk * 16 + offset + 1;
				const vector = new Float32Array([1, id / 100, 0]);
				Buffer.from(vector.buffer).copy(vectors, offset * 12);
				rowids.writeBigInt64LE(BigInt(id), offset * 8);
				db.prepare("INSERT INTO oracle VALUES (?,?)").run(id, vector);
				if (id % 3 !== 0) {
					eligibility[offset >> 3] |= 1 << (offset & 7);
					eligibleIds.push(id);
				}
			}
			chunks.push({ vectors, rowids, validity: Buffer.from([255, 255]), eligibility });
		}
		const query = new Float32Array([1, 0, 0]);
		const expected = db
			.query<{ id: number; distance: number }, [Float32Array, string]>(
				"SELECT id,distance FROM oracle WHERE embedding MATCH ? AND k=7 AND id IN(SELECT value FROM json_each(?)) ORDER BY distance",
			)
			.all(query, JSON.stringify(eligibleIds));
		expect(scan(query, chunks, 7)).toEqual({
			rows: expected.map((row) => ({ rowid: String(row.id), distance: row.distance })),
			scannedRows: 32,
			eligibleRows: eligibleIds.length,
			heapPeak: 7,
		});
		expect(() => scan(query, [{ ...chunks[0], eligibility: Buffer.alloc(0) }], 7)).toThrow("invalid admitted chunk");
	} finally {
		db.close();
	}
});
