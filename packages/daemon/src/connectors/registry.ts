/**
 * CRUD operations for the `connectors` table.
 *
 * All reads go through `withReadDb`, all writes through `withWriteTx`.
 * Timestamps are ISO strings; IDs are random UUIDs.
 */

import type { DbAccessor } from "../db-accessor";
import type {
	ConnectorConfig,
	ConnectorRow,
	ConnectorStatus,
	SyncCursor,
} from "@signet/core";

// ---------------------------------------------------------------------------
// Write operations
// ---------------------------------------------------------------------------

/**
 * Insert a new connector row and return its generated id.
 */
export function registerConnector(
	accessor: DbAccessor,
	config: ConnectorConfig,
): string {
	const id = crypto.randomUUID();
	const now = new Date().toISOString();

	accessor.withWriteTx((db) => {
		db.prepare(
			`INSERT INTO connectors
			 (id, provider, display_name, config_json, cursor_json, status,
			  last_sync_at, last_error, created_at, updated_at)
			 VALUES (?, ?, ?, ?, NULL, 'idle', NULL, NULL, ?, ?)`,
		).run(
			id,
			config.provider,
			config.displayName,
			JSON.stringify(config),
			now,
			now,
		);
	});

	return id;
}

/**
 * Update a connector's status and, optionally, its last_error field.
 * Clears last_error when no error string is provided.
 */
export function updateConnectorStatus(
	accessor: DbAccessor,
	id: string,
	status: ConnectorStatus,
	error?: string,
): void {
	const now = new Date().toISOString();

	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE connectors
			 SET status = ?, last_error = ?, updated_at = ?
			 WHERE id = ?`,
		).run(status, error ?? null, now, id);
	});
}

/**
 * Persist an updated sync cursor after a successful sync run.
 */
export function updateCursor(
	accessor: DbAccessor,
	id: string,
	cursor: SyncCursor,
): void {
	const now = new Date().toISOString();

	accessor.withWriteTx((db) => {
		db.prepare(
			`UPDATE connectors
			 SET cursor_json = ?, last_sync_at = ?, updated_at = ?
			 WHERE id = ?`,
		).run(JSON.stringify(cursor), cursor.lastSyncAt, now, id);
	});
}

/**
 * Delete a connector row. Returns true when a row was actually removed.
 */
export function removeConnector(accessor: DbAccessor, id: string): boolean {
	// Count before delete — bun:sqlite .changes can be inflated by triggers.
	const before = accessor.withReadDb((db) => {
		const row = db
			.prepare("SELECT COUNT(*) AS n FROM connectors WHERE id = ?")
			.get(id) as { n: number } | undefined;
		return row?.n ?? 0;
	});

	if (before === 0) return false;

	accessor.withWriteTx((db) => {
		db.prepare("DELETE FROM connectors WHERE id = ?").run(id);
	});

	return true;
}

// ---------------------------------------------------------------------------
// Read operations
// ---------------------------------------------------------------------------

/**
 * Fetch a single connector by id. Returns undefined when not found.
 */
export function getConnector(
	accessor: DbAccessor,
	id: string,
): ConnectorRow | undefined {
	return accessor.withReadDb((db) => {
		return db
			.prepare("SELECT * FROM connectors WHERE id = ?")
			.get(id) as ConnectorRow | undefined;
	});
}

/**
 * Return all connectors, newest first.
 */
export function listConnectors(
	accessor: DbAccessor,
): readonly ConnectorRow[] {
	return accessor.withReadDb((db) => {
		return db
			.prepare("SELECT * FROM connectors ORDER BY created_at DESC")
			.all() as ConnectorRow[];
	});
}

/**
 * Count documents whose source_url begins with the connector's root path.
 *
 * The root path is read from the connector's config_json settings.path
 * field. Returns 0 when the connector is not found or has no path setting.
 */
export function getConnectorDocumentCount(
	accessor: DbAccessor,
	connectorId: string,
): number {
	const row = getConnector(accessor, connectorId);
	if (row === undefined) return 0;

	// Pull the root path out of config_json without using `as` or `any`.
	let rootPath: string | null = null;
	try {
		const parsed: unknown = JSON.parse(row.config_json);
		if (
			typeof parsed === "object" &&
			parsed !== null &&
			"settings" in parsed
		) {
			const settings = (parsed as { settings: unknown }).settings;
			if (
				typeof settings === "object" &&
				settings !== null &&
				"path" in settings
			) {
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

	return accessor.withReadDb((db) => {
		const result = db
			.prepare(
				`SELECT COUNT(*) AS n FROM documents
				 WHERE source_url LIKE ? ESCAPE '\\'`,
			)
			.get(`${prefix.replace(/[%_\\]/g, "\\$&")}%`) as
			| { n: number }
			| undefined;
		return result?.n ?? 0;
	});
}
