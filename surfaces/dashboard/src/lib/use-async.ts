import { useEffect, useState } from "react";
export function useAsync<T>(
	fetcher: () => Promise<T | null>,
	opts: { intervalMs?: number; deps?: unknown[] } = {},
): { data: T | null; loading: boolean; refresh: () => void } {
	const [data, setData] = useState<T | null>(null);
	const [loading, setLoading] = useState(true);

	useEffect(() => {
		let alive = true;
		setLoading(true);
		const run = async () => {
			try {
				const result = await fetcher();
				if (alive) {
					setData(result);
					setLoading(false);
				}
			} catch {
				if (alive) setLoading(false);
			}
		};
		run();
		const id = opts.intervalMs ? setInterval(run, opts.intervalMs) : undefined;
		return () => {
			alive = false;
			if (id) clearInterval(id);
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, opts.deps ?? []);

	const refresh = async () => {
		try {
			setLoading(true);
			const result = await fetcher();
			setData(result);
		} finally {
			setLoading(false);
		}
	};

	return { data, loading, refresh };
}
