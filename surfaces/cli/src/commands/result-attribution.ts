import { attributeResults } from "../lib/result-attribution.js";
export function attributed<T extends object>(
	rows: readonly T[],
	call: (method: string, path: string, body?: unknown) => Promise<{ ok: boolean; data: unknown }>,
	memory = false,
) {
	return attributeResults(
		rows,
		async (body) => {
			const result = await call("POST", "/api/result-attribution", body);
			if (!result.ok) throw new Error("Canonical attribution is unavailable; no author identity was inferred");
			return result.data;
		},
		memory,
	);
}
