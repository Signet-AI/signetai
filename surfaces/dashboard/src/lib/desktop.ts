export interface WorkspaceMigrationUiStatus {
	readonly appVersion: string;
	readonly available: boolean;
	readonly state: "available" | "interrupted" | "completed" | "blocked" | "running" | "failed";
	readonly phase?: string;
	readonly copied?: number;
	readonly rollbackAvailable?: boolean;
	readonly blockers?: readonly string[];
	readonly reason?: string;
}

export interface WorkspaceMigrationResult {
	readonly state: "completed" | "rolled-back" | "blocked" | "running" | "failed";
}

export interface DesktopBridge {
	readonly openExternal: (url: string) => Promise<void>;
	readonly setTitleBarTheme?: (theme: "light" | "dark") => Promise<unknown>;
	readonly getWorkspaceMigrationStatus?: () => Promise<WorkspaceMigrationUiStatus>;
	readonly startWorkspaceMigration?: () => Promise<WorkspaceMigrationResult>;
	readonly rollbackWorkspaceMigration?: () => Promise<WorkspaceMigrationResult>;
}

declare global {
	interface Window {
		readonly signetDesktop?: DesktopBridge;
	}
}

export function getDesktopBridge(): DesktopBridge | null {
	if (typeof window === "undefined") return null;
	const bridge = window.signetDesktop;
	return bridge && typeof bridge.openExternal === "function" ? bridge : null;
}

export function syncDesktopTitleBarTheme(theme: string | undefined): void {
	if (theme !== "light" && theme !== "dark") return;
	const request = getDesktopBridge()?.setTitleBarTheme?.(theme);
	void request?.catch(() => undefined);
}
