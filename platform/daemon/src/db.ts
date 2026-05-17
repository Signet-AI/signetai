const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";
const require = (await import("node:module")).createRequire(import.meta.url);

let Database: new (path: string, opts?: Record<string, unknown>) => unknown;

if (isBun) {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	const sqlite = require("bun:sqlite");
	Database = sqlite.Database;
} else {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	Database = require("better-sqlite3");
}

export { Database };

export default Database;
