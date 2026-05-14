const isBun = typeof (globalThis as Record<string, unknown>).Bun !== "undefined";

let Database: new (path: string, opts?: Record<string, unknown>) => unknown;

if (isBun) {
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	({ Database } = require("bun:sqlite"));
} else {
	const { createRequire } = await import("node:module");
	// eslint-disable-next-line @typescript-eslint/no-require-imports
	Database = createRequire(import.meta.url)("better-sqlite3");
}

export { Database };

export default Database;
