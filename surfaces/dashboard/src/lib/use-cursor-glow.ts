import { useCallback, type RefObject } from "react";

/**
 * Tracks the cursor over an element and writes its position to the `--mx`/`--my`
 * CSS custom properties, which `.sig-surface::after` consumes to render the
 * cursor-following radial border glow. Attach the returned handler to onMouseMove.
 */
export function useCursorGlow<T extends HTMLElement>(): {
	onMouseMove: (e: React.MouseEvent<T>) => void;
} {
	const onMouseMove = useCallback((e: React.MouseEvent<T>) => {
		const el = e.currentTarget;
		const r = el.getBoundingClientRect();
		el.style.setProperty("--mx", `${e.clientX - r.left}px`);
		el.style.setProperty("--my", `${e.clientY - r.top}px`);
	}, []);
	return { onMouseMove };
}

/** For elements consumed via ref (non-React event binding). */
export function attachCursorGlow(el: HTMLElement | null): void {
	if (!el) return;
	el.addEventListener("mousemove", (e: MouseEvent) => {
		const r = el.getBoundingClientRect();
		el.style.setProperty("--mx", `${e.clientX - r.left}px`);
		el.style.setProperty("--my", `${e.clientY - r.top}px`);
	});
}
