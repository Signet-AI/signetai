import { useCallback, type RefObject } from "react";
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
export function attachCursorGlow(el: HTMLElement | null): void {
	if (!el) return;
	el.addEventListener("mousemove", (e: MouseEvent) => {
		const r = el.getBoundingClientRect();
		el.style.setProperty("--mx", `${e.clientX - r.left}px`);
		el.style.setProperty("--my", `${e.clientY - r.top}px`);
	});
}
