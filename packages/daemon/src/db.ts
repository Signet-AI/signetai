/**
 * SQLite database wrapper using bun:sqlite
 * API compatible with better-sqlite3 for easy migration
 */
import { Database } from "bun:sqlite";

export { Database };

// Re-export for drop-in replacement
export default Database;
