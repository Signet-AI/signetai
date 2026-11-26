import { configureEvidencePurgeConnection } from "@signet/core";

interface SQLiteDatabase {
	transaction<T>(operation: () => T): () => T;
	pragma(pragma: string): void;
	exec(sql: string): void;
	prepare(sql: string): {
		run(...args: unknown[]): void;
		get(...args: unknown[]): Record<string, unknown> | undefined;
		all(...args: unknown[]): Record<string, unknown>[];
	};
	close(): void;
}
const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";
const createDatabase = (dbPath: string, options?: { readonly?: boolean }): SQLiteDatabase => {
	const db: SQLiteDatabase = isBun
		? new (require("bun:sqlite").Database)(dbPath, options)
		: new (require("better-sqlite3"))(dbPath, options);
	configureEvidencePurgeConnection(db);
	return db;
};

export { createDatabase };
export default createDatabase;
