/**
 * CRUD operations for the `connectors` table.
 *
 * All reads go through `withReadDb`, all writes through `withWriteTx`.
 * Timestamps are ISO strings; IDs are random UUIDs.
 */

import type { DbAccessor } from "../db-accessor";
import type { ConnectorConfig, ConnectorRow, ConnectorStatus, SyncCursor } from "@signet/core";

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Insert a new connector row and return its generated id.
 */
export function registerConnector(accessor: DbAccessor, config: ConnectorConfig): string {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	accessor.withWriteTx((db: import("../db-accessor").WriteDb) => {
		db.prepare(
			`INSERT INTO connectors
			 (id, provider, display_name, config_json, cursor_json, status,
			  last_sync_at, last_error, created_at, updated_at)
			 VALUES (?, ?, ?, ?, NULL, 'idle', NULL, NULL, ?, ?)`,
		).run(id, config.provider, config.displayName, JSON.stringify(config), now, now);
	}, "connectors/registry.ts:23");

	return id;
}

/**
 * Update a connector's status and, optionally, its last_error field.
 * Clears last_error when no error string is provided.
 */
export function updateConnectorStatus(accessor: DbAccessor, id: string, status: ConnectorStatus, error?: string): void {
	const now = new Date().toISOString();

	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	accessor.withWriteTx((db: import("../db-accessor").WriteDb) => {
		db.prepare(
			`UPDATE connectors
			 SET status = ?, last_error = ?, updated_at = ?
			 WHERE id = ?`,
		).run(status, error ?? null, now, id);
	}, "connectors/registry.ts:43");
}

/**
 * Persist an updated sync cursor after a successful sync run.
 */
export function updateCursor(accessor: DbAccessor, id: string, cursor: SyncCursor): void {
	const now = new Date().toISOString();

	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	accessor.withWriteTx((db: import("../db-accessor").WriteDb) => {
		db.prepare(
			`UPDATE connectors
			 SET cursor_json = ?, last_sync_at = ?, updated_at = ?
			 WHERE id = ?`,
		).run(JSON.stringify(cursor), cursor.lastSyncAt, now, id);
	}, "connectors/registry.ts:59");
}

/**
 * Delete a connector row. Returns true when a row was actually removed.
 */
export function removeConnector(accessor: DbAccessor, id: string): boolean {
	// Count before delete — bun:sqlite .changes can be inflated by triggers.
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	const before = accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
		const row = db.prepare("SELECT COUNT(*) AS n FROM connectors WHERE id = ?").get(id) as { n: number } | undefined;
		return row?.n ?? 0;
	}, "connectors/registry.ts:74");

	if (before === 0) return false;

	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	accessor.withWriteTx((db: import("../db-accessor").WriteDb) => {
		db.prepare("DELETE FROM connectors WHERE id = ?").run(id);
	}, "connectors/registry.ts:82");

	return true;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Fetch a single connector by id. Returns undefined when not found.
 */
export function getConnector(accessor: DbAccessor, id: string): ConnectorRow | undefined {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
		return db.prepare("SELECT * FROM connectors WHERE id = ?").get(id) as ConnectorRow | undefined;
	}, "connectors/registry.ts:98");
}

/**
 * Return all connectors, newest first.
 */
export function listConnectors(accessor: DbAccessor): readonly ConnectorRow[] {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
		return db.prepare("SELECT * FROM connectors ORDER BY created_at DESC").all() as ConnectorRow[];
	}, "connectors/registry.ts:108");
}

/** Async diagnostic projection used by heartbeat and other background paths. */
export async function listConnectorsAsync(accessor: DbAccessor): Promise<readonly ConnectorRow[]> {
	return await accessor.withReadDbAsync(
		(db) => db.prepare("SELECT * FROM connectors ORDER BY created_at DESC").all() as ConnectorRow[],
		{ siteToken: "connectors/registry.ts:115", operation: "heartbeat.list-connectors" },
	);
}

/**
 * Count documents whose source_url begins with the connector's root path.
 *
 * The root path is read from the connector's config_json settings.path
 * field. Returns 0 when the connector is not found or has no path setting.
 */
export function getConnectorDocumentCount(accessor: DbAccessor, connectorId: string): number {
	const row = getConnector(accessor, connectorId);
	if (row === undefined) return 0;

	// Pull the root path out of config_json without using `as` or `any`.
	let rootPath: string | null = null;
	try {
		const parsed: unknown = JSON.parse(row.config_json);
		if (typeof parsed === "object" && parsed !== null && "settings" in parsed) {
			const settings = (parsed as { settings: unknown }).settings;
			if (typeof settings === "object" && settings !== null && "path" in settings) {
				const path = (settings as { path: unknown }).path;
				if (typeof path === "string") {
					rootPath = path;
				}
			}
		}
	} catch {
		// malformed config_json — treat as no path
	}

	if (rootPath === null) return 0;

	const prefix = rootPath.endsWith("/") ? rootPath : `${rootPath}/`;

	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
		const result = db
			.prepare(
				`SELECT COUNT(*) AS n FROM documents
				 WHERE source_url LIKE ? ESCAPE '\\'`,
			)
			.get(`${prefix.replace(/[%_\\]/g, "\\$&")}%`) as { n: number } | undefined;
		return result?.n ?? 0;
	}, "connectors/registry.ts:153");
}
