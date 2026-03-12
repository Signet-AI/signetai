/**
 * Titlebar decoration mode store.
 *
 * Modes:
 *   "macos"   — traffic-light buttons on the left, centered title
 *   "windows" — minimize/maximize/close on the right, left-aligned title
 *   "none"    — no titlebar, pure content (chromeless)
 *
 * Only active inside the Tauri desktop shell. In a normal browser session
 * this store always resolves to "none" so the web dashboard never renders
 * a phantom titlebar offset.
 */

export type DecorationMode = "macos" | "windows" | "none";

const STORAGE_KEY = "signet-decoration-mode";

function isTauriShell(): boolean {
	return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

function detectOS(): DecorationMode {
	if (typeof navigator === "undefined") return "none";
	const ua = navigator.userAgent.toLowerCase();
	if (ua.includes("mac")) return "macos";
	if (ua.includes("win")) return "windows";
	// Linux — default to windows-style (more familiar with close on right)
	return "windows";
}

function loadMode(): DecorationMode {
	if (!isTauriShell()) return "none";
	if (typeof localStorage === "undefined") return detectOS();
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored === "macos" || stored === "windows" || stored === "none") {
		return stored;
	}
	return detectOS();
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
	get visible() {
		return mode !== "none";
	},
	/** Height in logical pixels — matches native OS chrome */
	get height() {
		if (mode === "none") return 0;
		return mode === "macos" ? 28 : 32;
	},
};
