export interface SignetAppEvents {
	readonly subscribe?: readonly string[];
	readonly emit?: readonly string[];
}

export interface SignetAppSize {
	readonly w: number;
	readonly h: number;
}
export interface SignetAppManifest {
	readonly name: string;
	readonly icon?: string;
	readonly ui?: string;
	readonly html?: string;
	readonly defaultSize?: SignetAppSize;
	readonly events?: SignetAppEvents;
	readonly menuItems?: readonly string[];
	readonly dock?: boolean;
}

export const DEFAULT_APP_SIZE: SignetAppSize = { w: 4, h: 3 };

export const WIDGET_SIZES = {
	small: { w: 3, h: 2 },
	medium: { w: 4, h: 3 },
	large: { w: 6, h: 4 },
} as const;

export type WidgetSizePreset = keyof typeof WIDGET_SIZES;

export interface AutoCardToolAction {
	readonly name: string;
	readonly description: string;
	readonly readOnly: boolean;
	readonly inputSchema: unknown;
}

export interface AutoCardResource {
	readonly uri: string;
	readonly name: string;
	readonly description?: string;
	readonly mimeType?: string;
}
export interface AutoCardManifest {
	readonly name: string;
	readonly icon?: string;
	readonly tools: readonly AutoCardToolAction[];
	readonly resources: readonly AutoCardResource[];
	readonly hasAppResources: boolean;
	readonly defaultSize: SignetAppSize;
}

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

export type AppTrayState = "tray" | "grid" | "dock";
export interface AppTrayEntry {
	readonly id: string;
	readonly name: string;
	readonly icon?: string;
	readonly state: AppTrayState;
	readonly manifest: SignetAppManifest;
	readonly autoCard: AutoCardManifest;
	readonly hasDeclaredManifest: boolean;
	readonly gridPosition?: { x: number; y: number; w: number; h: number };
	readonly createdAt: string;
	readonly updatedAt: string;
}

export interface SignetOSEvent {
	readonly id: string;
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
