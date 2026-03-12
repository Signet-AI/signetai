/**
 * UI scale store — replaces browser zoom with controlled CSS zoom.
 *
 * Uses the CSS `zoom` property on the root element, which scales
 * everything uniformly (text, spacing, borders) while keeping SVG
 * stroke rendering consistent — unlike browser-level zoom which
 * causes stroke-width distortion in WebKit.
 *
 * Persisted in localStorage.
 */

const STORAGE_KEY = "signet-ui-scale";
const STEPS = [0.5, 0.6, 0.7, 0.8, 0.85, 0.9, 0.95, 1.0, 1.1, 1.2, 1.3, 1.5, 1.75, 2.0, 2.5, 3.0] as const;
const DEFAULT_INDEX = 7; // 1.0

function loadIndex(): number {
	if (typeof localStorage === "undefined") return DEFAULT_INDEX;
	const stored = localStorage.getItem(STORAGE_KEY);
	if (stored !== null) {
		const n = Number(stored);
		if (Number.isInteger(n) && n >= 0 && n < STEPS.length) return n;
	}
	return DEFAULT_INDEX;
}

let index = $state(loadIndex());

function applyScale(): void {
	if (typeof document === "undefined") return;
	const scale = STEPS[index];
	// CSS zoom scales everything uniformly — text, spacing, SVGs —
	// without the WebKit stroke-width rendering bugs that come from
	// the browser's native zoom implementation.
	document.documentElement.style.zoom = String(scale);
	document.documentElement.style.setProperty("--ui-scale", String(scale));
}

// Apply on load
if (typeof document !== "undefined") {
	applyScale();
}

export const uiScale = {
	get value(): number {
		return STEPS[index];
	},
	get index(): number {
		return index;
	},
	get steps(): readonly number[] {
		return STEPS;
	},
	get percent(): string {
		return `${Math.round(STEPS[index] * 100)}%`;
	},
	zoomIn(): void {
		if (index < STEPS.length - 1) {
			index++;
			applyScale();
			localStorage.setItem(STORAGE_KEY, String(index));
		}
	},
	zoomOut(): void {
		if (index > 0) {
			index--;
			applyScale();
			localStorage.setItem(STORAGE_KEY, String(index));
		}
	},
	reset(): void {
		index = DEFAULT_INDEX;
		applyScale();
		localStorage.setItem(STORAGE_KEY, String(index));
	},
	/** Call from a wheel handler to zoom with Ctrl+scroll */
	handleZoomWheel(e: WheelEvent): boolean {
		if (!(e.ctrlKey || e.metaKey)) return false;
		e.preventDefault();
		if (e.deltaY < 0) {
			uiScale.zoomIn();
		} else if (e.deltaY > 0) {
			uiScale.zoomOut();
		}
		return true;
	},
	/** Call from a keydown handler to intercept Ctrl+/Ctrl-/Ctrl+0 */
	handleZoomKey(e: KeyboardEvent): boolean {
		if (!(e.ctrlKey || e.metaKey)) return false;
		if (e.key === "=" || e.key === "+") {
			e.preventDefault();
			uiScale.zoomIn();
			return true;
		}
		if (e.key === "-") {
			e.preventDefault();
			uiScale.zoomOut();
			return true;
		}
		if (e.key === "0") {
			e.preventDefault();
			uiScale.reset();
			return true;
		}
		return false;
	},
};
