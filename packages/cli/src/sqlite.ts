/**
 * Runtime-detecting SQLite wrapper
 * Uses bun:sqlite under Bun, better-sqlite3 under Node.js
 *
 * This module provides a synchronous API compatible with both implementations.
 */

// Common interface shared by both bun:sqlite and better-sqlite3
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

// Detect runtime once at module load
const isBun = typeof (globalThis as any).Bun !== "undefined";

/**
 * Create a SQLite database connection
 * Compatible with better-sqlite3 API for drop-in replacement
 */
export function createDatabase(
	dbPath: string,
	options?: { readonly?: boolean },
): SQLiteDatabase {
	if (isBun) {
		// Bun runtime - use built-in bun:sqlite
		// We need to use require-style for bun:sqlite to work with bundlers
		const { Database } = require("bun:sqlite");
		return new Database(dbPath, options);
	} else {
		// Node.js runtime - use better-sqlite3
		const BetterSqlite3 = require("better-sqlite3");
		return new BetterSqlite3(dbPath, options);
	}
}

// Default export matching better-sqlite3's API
export default createDatabase;
