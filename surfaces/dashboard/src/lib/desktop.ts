export interface DesktopBridge {
	readonly openExternal: (url: string) => Promise<void>;
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
