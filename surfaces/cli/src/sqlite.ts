interface SQLiteDatabase {
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
	if (isBun) {
		const { Database } = require("bun:sqlite");
		return new Database(dbPath, options);
	} else {
		const BetterSqlite3 = require("better-sqlite3");
		return new BetterSqlite3(dbPath, options);
	}
};

export { createDatabase };
export default createDatabase;
