/**
 * Titlebar decoration mode store.
 *
 * Modes:
 *   "macos"   — traffic-light buttons on the left, centered title
 *   "windows" — minimize/maximize/close on the right, left-aligned title
 *   "none"    — no titlebar, pure content (chromeless)
 *
 * Only active inside the desktop shell. In a normal browser session
 * this store always resolves to "none" so the web dashboard never renders
 * a phantom titlebar offset.
 */

import { getDesktopShell, isDesktopShell } from "$lib/desktop-shell";

export type DecorationMode = "macos" | "windows" | "none";

const STORAGE_KEY = "signet-desktop-decoration-mode";

function detectOS(): DecorationMode {
	if (typeof navigator === "undefined") return "none";
	const ua = navigator.userAgent.toLowerCase();
	if (ua.includes("mac")) return "macos";
	if (ua.includes("win")) return "windows";
	// Linux — default to windows-style (more familiar with close on right)
	return "windows";
}

function usesNativeFrame(): boolean {
	return getDesktopShell()?.nativeFrame ?? false;
}

function defaultMode(): DecorationMode {
	return usesNativeFrame() ? "none" : detectOS();
}

function loadMode(): DecorationMode {
	if (!isDesktopShell()) return "none";
	if (usesNativeFrame()) return "none";
	if (typeof localStorage === "undefined") return defaultMode();
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored === "macos" || stored === "windows" || stored === "none") {
		return stored;
	}
	return defaultMode();
}

let mode = $state<DecorationMode>(loadMode());

export const titlebar = {
	get mode() {
		return mode;
	},
	set mode(v: DecorationMode) {
		mode = v;
		if (typeof localStorage !== "undefined") {
			localStorage.setItem(STORAGE_KEY, v);
		}
	},
	get nativeFrame() {
		return usesNativeFrame();
	},
	get visible() {
		return !usesNativeFrame() && mode !== "none";
	},
	/** Height in logical pixels — matches native OS chrome */
	get height() {
		if (usesNativeFrame() || mode === "none") return 0;
		return mode === "macos" ? 28 : 32;
	},
};
