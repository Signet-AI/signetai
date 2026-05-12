const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";

let Database: new (path: string, opts?: Record<string, unknown>) => unknown;

if (isBun) {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	({ Database } = require("bun:sqlite"));
} else {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	Database = require("better-sqlite3");
}

export { Database };

export default Database;
