import { useCallback, useEffect, useState } from "react";
import { type ApiReadResult, getJSONResult } from "./api";

export function usePanelQuery<T>(path: string | null) {
	const [result, setResult] = useState<ApiReadResult<T> | null>(null);
	const [generation, setGeneration] = useState(0);
	const refresh = useCallback(() => setGeneration((value) => value + 1), []);
	useEffect(() => {
		const controller = new AbortController();
		setResult(null);
		if (path)
			void getJSONResult<T>(path, { signal: controller.signal }).then((next) => {
				if (!controller.signal.aborted) setResult(next);
			});
		return () => controller.abort();
	}, [path, generation]);
	return { result, refresh };
}
