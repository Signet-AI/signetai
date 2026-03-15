/**
 * Signet OS types — manifest schema and app tray definitions.
 *
 * Based on the Signet OS spec: docs/signet-os-spec.md
 * These types define how MCP servers declare their dashboard presence.
 */

// ---------------------------------------------------------------------------
// Manifest types (what MCP servers declare or Signet auto-generates)
// ---------------------------------------------------------------------------

/**
 * Event subscription/emission declarations for the ambient awareness layer.
 */
export interface SignetAppEvents {
	/** Browser/system events this app wants to receive */
	readonly subscribe?: readonly string[];
	/** Events this app produces (for documentation/wiring) */
	readonly emit?: readonly string[];
}

/**
 * Grid size in dashboard grid units.
 */
export interface SignetAppSize {
	/** Width in grid units */
	readonly w: number;
	/** Height in grid units */
	readonly h: number;
}

/**
 * The `signet` block that MCP servers can declare in their metadata.
 * Optional — servers without it get auto-generated fallback cards.
 */
export interface SignetAppManifest {
	/** Display name */
	readonly name: string;
	/** Icon path or URL. Inferred from server metadata if absent */
	readonly icon?: string;
	/** URL of the widget UI. Auto-card rendered if absent */
	readonly ui?: string;
	/** Grid units. Default: { w: 4, h: 3 } */
	readonly defaultSize?: SignetAppSize;
	/** Event bus subscriptions and emissions */
	readonly events?: SignetAppEvents;
	/** Items added to the Signet OS menu bar under this app's name */
	readonly menuItems?: readonly string[];
	/** Pin to dock on install. Default: false */
	readonly dock?: boolean;
}

/**
 * Default grid size when none is specified.
 */
export const DEFAULT_APP_SIZE: SignetAppSize = { w: 4, h: 3 };

// ---------------------------------------------------------------------------
// Auto-card types (generated when no manifest or UI is present)
// ---------------------------------------------------------------------------

/**
 * A tool action exposed in an auto-generated card.
 * Each becomes a clickable button with an inline arg form.
 */
export interface AutoCardToolAction {
	/** Tool name as exposed by the MCP server */
	readonly name: string;
	/** Human-readable description */
	readonly description: string;
	/** Whether the tool is read-only (hint from MCP annotations) */
	readonly readOnly: boolean;
	/** JSON Schema for the tool's input parameters */
	readonly inputSchema: unknown;
}

/**
 * A resource exposed by the MCP server.
 */
export interface AutoCardResource {
	/** Resource URI (e.g., "app://...", "file://...") */
	readonly uri: string;
	/** Human-readable name */
	readonly name: string;
	/** Optional description */
	readonly description?: string;
	/** MIME type if known */
	readonly mimeType?: string;
}

/**
 * Auto-generated card manifest, created when an MCP server doesn't
 * declare a `signet` block or `signet.ui` URL.
 */
export interface AutoCardManifest {
	/** Server name used as display name */
	readonly name: string;
	/** Inferred icon (placeholder if none available) */
	readonly icon?: string;
	/** Tools exposed as clickable action buttons */
	readonly tools: readonly AutoCardToolAction[];
	/** Resources discovered from the server */
	readonly resources: readonly AutoCardResource[];
	/** Whether app:// resources were found (MCP Apps SDK support) */
	readonly hasAppResources: boolean;
	/** Default grid size */
	readonly defaultSize: SignetAppSize;
}

// ---------------------------------------------------------------------------
// Probe result (returned by probeServer)
// ---------------------------------------------------------------------------

/**
 * Result of probing an MCP server on install.
 */
export interface McpProbeResult {
	/** The server ID that was probed */
	readonly serverId: string;
	/** Whether the probe succeeded */
	readonly ok: boolean;
	/** Error message if probe failed */
	readonly error?: string;
	/** The declared manifest (from signet block in server metadata) */
	readonly declaredManifest?: SignetAppManifest;
	/** The auto-generated card (fallback when no signet block or UI) */
	readonly autoCard: AutoCardManifest;
	/** Raw tools discovered */
	readonly toolCount: number;
	/** Raw resources discovered */
	readonly resourceCount: number;
	/** Whether the server had app:// resources */
	readonly hasAppResources: boolean;
	/** Timestamp of the probe */
	readonly probedAt: string;
}

// ---------------------------------------------------------------------------
// App Tray entry (stored per-server, persisted to disk)
// ---------------------------------------------------------------------------

/**
 * Placement state of an app in the dashboard.
 */
export type AppTrayState = "tray" | "grid" | "dock";

/**
 * An entry in the App Tray. Created on install, persisted to
 * ~/.agents/marketplace/app-tray.json
 */
export interface AppTrayEntry {
	/** Server ID (matches InstalledMarketplaceMcpServer.id) */
	readonly id: string;
	/** Display name (from manifest or auto-card) */
	readonly name: string;
	/** Icon URL or path */
	readonly icon?: string;
	/** Current placement state */
	readonly state: AppTrayState;
	/** The full manifest (declared or auto-generated as SignetAppManifest) */
	readonly manifest: SignetAppManifest;
	/** Auto-card data (always present, used when no UI URL) */
	readonly autoCard: AutoCardManifest;
	/** Whether a declared manifest was found */
	readonly hasDeclaredManifest: boolean;
	/** Grid position (only when state === 'grid') */
	readonly gridPosition?: { x: number; y: number; w: number; h: number };
	/** When this entry was created */
	readonly createdAt: string;
	/** When this entry was last updated */
	readonly updatedAt: string;
}
