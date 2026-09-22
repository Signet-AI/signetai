import type { DbAccessor } from "../db-accessor";
import type { ConnectorConfig, ConnectorRow, ConnectorStatus, SyncCursor } from "@signet/core";
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
	}, "connectors/registry.ts:8");

	return id;
}
export function updateConnectorStatus(accessor: DbAccessor, id: string, status: ConnectorStatus, error?: string): void {
	const now = new Date().toISOString();

	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	accessor.withWriteTx((db: import("../db-accessor").WriteDb) => {
		db.prepare(
			`UPDATE connectors
			 SET status = ?, last_error = ?, updated_at = ?
			 WHERE id = ?`,
		).run(status, error ?? null, now, id);
	}, "connectors/registry.ts:23");
}
export function updateCursor(accessor: DbAccessor, id: string, cursor: SyncCursor): void {
	const now = new Date().toISOString();

	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	accessor.withWriteTx((db: import("../db-accessor").WriteDb) => {
		db.prepare(
			`UPDATE connectors
			 SET cursor_json = ?, last_sync_at = ?, updated_at = ?
			 WHERE id = ?`,
		).run(JSON.stringify(cursor), cursor.lastSyncAt, now, id);
	}, "connectors/registry.ts:35");
}
export function removeConnector(accessor: DbAccessor, id: string): boolean {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	const before = accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
		const row = db.prepare("SELECT COUNT(*) AS n FROM connectors WHERE id = ?").get(id) as { n: number } | undefined;
		return row?.n ?? 0;
	}, "connectors/registry.ts:45");

	if (before === 0) return false;

	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withWriteTx migration site
	accessor.withWriteTx((db: import("../db-accessor").WriteDb) => {
		db.prepare("DELETE FROM connectors WHERE id = ?").run(id);
	}, "connectors/registry.ts:53");

	return true;
}
export function getConnector(accessor: DbAccessor, id: string): ConnectorRow | undefined {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
		return db.prepare("SELECT * FROM connectors WHERE id = ?").get(id) as ConnectorRow | undefined;
	}, "connectors/registry.ts:61");
}
export function listConnectors(accessor: DbAccessor): readonly ConnectorRow[] {
	// @ts-expect-error LEGACY_SYNC_DB_ACCESS: withReadDb migration site
	return accessor.withReadDb((db: import("../db-accessor").ReadDb) => {
		return db.prepare("SELECT * FROM connectors ORDER BY created_at DESC").all() as ConnectorRow[];
	}, "connectors/registry.ts:67");
}
export async function listConnectorsAsync(accessor: DbAccessor): Promise<readonly ConnectorRow[]> {
	return await accessor.withReadDbAsync(
		(db) => db.prepare("SELECT * FROM connectors ORDER BY created_at DESC").all() as ConnectorRow[],
		{ siteToken: "connectors/registry.ts:72", operation: "heartbeat.list-connectors" },
	);
}
export function getConnectorDocumentCount(accessor: DbAccessor, connectorId: string): number {
	const row = getConnector(accessor, connectorId);
	if (row === undefined) return 0;
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
	} catch {}

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
	}, "connectors/registry.ts:99");
}
