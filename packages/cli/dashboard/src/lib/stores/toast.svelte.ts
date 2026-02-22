/**
 * Toast wrapper around svelte-sonner.
 * Maintains the same API so existing callsites don't need changes.
 */

import { toast as sonnerToast } from "svelte-sonner";

export type ToastLevel = "info" | "success" | "error" | "warning";

export function toast(
	message: string,
	level: ToastLevel = "info",
	duration = 3000,
): void {
	const opts = { duration };
	switch (level) {
		case "success":
			sonnerToast.success(message, opts);
			break;
		case "error":
			sonnerToast.error(message, opts);
			break;
		case "warning":
			sonnerToast.warning(message, opts);
			break;
		default:
			sonnerToast.info(message, opts);
			break;
	}
}
