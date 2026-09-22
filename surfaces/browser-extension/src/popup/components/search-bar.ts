import { recallMemories } from "../../shared/api.js";
import type { Memory } from "../../shared/types.js";

export function initSearch(
	input: HTMLInputElement,
	onResults: (memories: readonly Memory[], query: string) => void,
	onClear: () => void,
): void {
	let debounceTimer: ReturnType<typeof setTimeout> | null = null;

	input.addEventListener("input", () => {
		if (debounceTimer !== null) clearTimeout(debounceTimer);

		const query = input.value.trim();
		if (query.length === 0) {
			onClear();
			return;
		}

		if (query.length < 2) return;

		debounceTimer = setTimeout(async () => {
			const result = await recallMemories(query, 15);
			onResults(result.memories, query);
		}, 300);
	});

	input.addEventListener("keydown", (e) => {
		if (e.key === "Escape") {
			input.value = "";
			onClear();
		}
	});
}
