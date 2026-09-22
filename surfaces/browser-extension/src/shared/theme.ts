import type { ThemeMode } from "./types.js";

export function resolveTheme(mode: ThemeMode): "dark" | "light" {
	if (mode === "dark" || mode === "light") return mode;
	return window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
}

export function applyTheme(root: HTMLElement, mode: ThemeMode): void {
	const resolved = resolveTheme(mode);
	root.setAttribute("data-theme", resolved);
}

export function watchSystemTheme(callback: (theme: "dark" | "light") => void): void {
	const mq = window.matchMedia("(prefers-color-scheme: light)");
	mq.addEventListener("change", (e) => {
		callback(e.matches ? "light" : "dark");
	});
}
