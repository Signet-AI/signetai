export const GRAPH_DENSITY_DEBOUNCE_MS = 180;

export interface DebouncedValue<T> {
	schedule(value: T): void;
	cancel(): void;
}

/** Schedules only the final value from a burst of slider events. */
export function createDebouncedValue<T>(delayMs: number, commit: (value: T) => void): DebouncedValue<T> {
	let timer: ReturnType<typeof setTimeout> | null = null;

	return {
		schedule(value) {
			if (timer) clearTimeout(timer);
			timer = setTimeout(() => {
				timer = null;
				commit(value);
			}, delayMs);
		},
		cancel() {
			if (timer) clearTimeout(timer);
			timer = null;
		},
	};
}
