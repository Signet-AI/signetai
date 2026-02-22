/**
 * Simple toast notification store using Svelte 5 runes.
 */

export type ToastLevel = "info" | "success" | "error" | "warning";

export interface ToastItem {
	id: number;
	message: string;
	level: ToastLevel;
}

let nextId = 0;

export const toasts = $state<ToastItem[]>([]);

export function toast(
	message: string,
	level: ToastLevel = "info",
	duration = 3000,
): void {
	const id = nextId++;
	toasts.push({ id, message, level });

	if (duration > 0) {
		setTimeout(() => dismiss(id), duration);
	}
}

export function dismiss(id: number): void {
	const index = toasts.findIndex((t) => t.id === id);
	if (index !== -1) toasts.splice(index, 1);
}
