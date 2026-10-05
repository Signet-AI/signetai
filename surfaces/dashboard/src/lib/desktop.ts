export interface DesktopBridge {
	readonly openExternal: (url: string) => Promise<void>;
	readonly setTitleBarTheme?: (theme: "light" | "dark") => Promise<unknown>;
	readonly pickDirectory?: (options?: { readonly title?: string }) => Promise<string | null>;
	readonly pickFiles?: (options?: { readonly title?: string }) => Promise<readonly string[] | null>;
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
