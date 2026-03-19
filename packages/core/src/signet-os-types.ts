/** Signet OS types — manifest schema, app tray, and event bus definitions. */

// ---------------------------------------------------------------------------
// Manifest types (what MCP servers declare or Signet auto-generates)
// ---------------------------------------------------------------------------

export interface SignetAppEvents {
	readonly subscribe?: readonly string[];
	readonly emit?: readonly string[];
}

export interface SignetAppSize {
	readonly w: number;
	readonly h: number;
}

/** The `signet` block that MCP servers can declare in their metadata. */
export interface SignetAppManifest {
	readonly name: string;
	readonly icon?: string;
	/** URL of the widget UI. Auto-card rendered if absent. */
	readonly ui?: string;
	readonly defaultSize?: SignetAppSize;
	readonly events?: SignetAppEvents;
	readonly menuItems?: readonly string[];
	/** Pin to dock on install. Default: false. */
	readonly dock?: boolean;
}

export const DEFAULT_APP_SIZE: SignetAppSize = { w: 4, h: 3 };

// ---------------------------------------------------------------------------
// Auto-card types (generated when no manifest or UI is present)
// ---------------------------------------------------------------------------

export interface AutoCardToolAction {
	readonly name: string;
	readonly description: string;
	/** From MCP annotations readOnlyHint */
	readonly readOnly: boolean;
	readonly inputSchema: unknown;
}

export interface AutoCardResource {
	readonly uri: string;
	readonly name: string;
	readonly description?: string;
	readonly mimeType?: string;
}

/** Auto-generated card manifest when no `signet` block or UI is declared. */
export interface AutoCardManifest {
	readonly name: string;
	readonly icon?: string;
	readonly tools: readonly AutoCardToolAction[];
	readonly resources: readonly AutoCardResource[];
	/** Whether app:// resources were found (MCP Apps SDK) */
	readonly hasAppResources: boolean;
	readonly defaultSize: SignetAppSize;
}

// ---------------------------------------------------------------------------
// Probe result (returned by probeServer)
// ---------------------------------------------------------------------------

export interface McpProbeResult {
	readonly serverId: string;
	readonly ok: boolean;
	readonly error?: string;
	readonly declaredManifest?: SignetAppManifest;
	readonly autoCard: AutoCardManifest;
	readonly toolCount: number;
	readonly resourceCount: number;
	readonly hasAppResources: boolean;
	readonly probedAt: string;
}

// ---------------------------------------------------------------------------
// App Tray entry (stored per-server, persisted to disk)
// ---------------------------------------------------------------------------

export type AppTrayState = "tray" | "grid" | "dock";

/** Persisted to ~/.agents/marketplace/app-tray.json */
export interface AppTrayEntry {
	readonly id: string;
	readonly name: string;
	readonly icon?: string;
	readonly state: AppTrayState;
	readonly manifest: SignetAppManifest;
	readonly autoCard: AutoCardManifest;
	readonly hasDeclaredManifest: boolean;
	/** Only set when state === 'grid' */
	readonly gridPosition?: { x: number; y: number; w: number; h: number };
	readonly createdAt: string;
	readonly updatedAt: string;
}

// ---------------------------------------------------------------------------
// Event Bus types (ambient awareness layer — Phase 3/5)
// ---------------------------------------------------------------------------

export interface SignetOSEvent {
	readonly id: string;
	/** "browser" | "mcp:<widgetId>" | "system" */
	readonly source: string;
	readonly type: string;
	readonly timestamp: number;
	readonly payload: Record<string, unknown>;
}

export type BrowserEventType =
	| "browser.navigate"
	| "browser.form"
	| "browser.dom.change"
	| "browser.extract"
	| "browser.checkout"
	| "browser.login";

export interface EventBusSubscription {
	readonly type: string;
	readonly id: string;
	readonly unsubscribe: () => void;
}

export interface ContextSnapshot {
	readonly events: readonly SignetOSEvent[];
	readonly totalEvents: number;
	readonly windowStart: number;
	readonly windowEnd: number;
	readonly activeSources: number;
	readonly generatedAt: number;
}
