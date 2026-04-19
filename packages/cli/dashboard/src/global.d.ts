import type { SignetDesktopBridge } from "$lib/desktop-shell";

declare global {
	interface Window {
		signetDesktop?: SignetDesktopBridge;
	}
}
