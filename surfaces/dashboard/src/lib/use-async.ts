import { useEffect, useRef, useState } from "react";
import { dashboardQueryCache, scopedQueryKey, type QueryResult } from "./query-cache";

export function useAsync<T>(
	fetcher: () => Promise<T | null>,
	opts: { intervalMs?: number; deps?: unknown[]; key?: string; staleMs?: number } = {},
): {
	data: T | null;
	loading: boolean;
	refreshing: boolean;
	error: string | null;
	stale: boolean;
	refresh: () => Promise<void>;
} {
	const key = opts.key ? scopedQueryKey(opts.key) : undefined;
	const cached = key ? dashboardQueryCache.read<T>(key) : null;
	const [state, setState] = useState<{ key: string | undefined; result: QueryResult<T>; refreshing: boolean }>(() => ({
		key,
		result: cached ?? { data: null, error: null, updatedAt: 0 },
		refreshing: false,
	}));
	const fetcherRef = useRef(fetcher);
	fetcherRef.current = fetcher;
	const runRef = useRef<(force?: boolean) => Promise<void>>(async () => {});
	const staleMs = opts.staleMs ?? opts.intervalMs ?? 30_000;
	const result = state.key === key ? state.result : (cached ?? { data: null, error: null, updatedAt: 0 });
	useEffect(() => {
		let alive = true;
		let running: Promise<void> | null = null;
		let rerun = false;
		const run = (force = false): Promise<void> => {
			if (key && opts.key && key !== scopedQueryKey(opts.key)) {
				setState({ key: undefined, result: { data: null, error: null, updatedAt: 0 }, refreshing: false });
				return Promise.resolve();
			}
			if (running) return running;
			setState((previous) => ({ ...previous, refreshing: true }));
			running = (async () => {
				const next = key
					? await dashboardQueryCache.fetch(key, () => fetcherRef.current(), staleMs, force)
					: await fetcherRef
							.current()
							.then((data) => ({
								data,
								error: data === null ? "Daemon data is unavailable." : null,
								updatedAt: Date.now(),
							}))
							.catch(() => ({ data: null, error: "Dashboard request failed.", updatedAt: 0 }));
				if (alive) setState({ key, result: next, refreshing: false });
			})().finally(() => {
				running = null;
				if (alive && rerun) {
					rerun = false;
					void run(true);
				}
			});
			return running;
		};
		runRef.current = run;
		const unsubscribe = key
			? dashboardQueryCache.subscribe(key, (invalidated) => {
					if (alive) {
						setState({ key, result: dashboardQueryCache.read<T>(key), refreshing: false });
						if (invalidated) {
							if (running) rerun = true;
							else void run(true);
						}
					}
				})
			: undefined;
		void run();
		const timer = opts.intervalMs
			? setInterval(() => {
					if (document.visibilityState !== "hidden") void run();
				}, opts.intervalMs)
			: undefined;
		const visible = () => {
			if (document.visibilityState !== "hidden") void run();
		};
		document.addEventListener("visibilitychange", visible);
		const storage = (event: StorageEvent) => {
			if (event.key === "signet-token") void run(true);
		};
		window.addEventListener("storage", storage);
		return () => {
			alive = false;
			unsubscribe?.();
			if (timer) clearInterval(timer);
			document.removeEventListener("visibilitychange", visible);
			window.removeEventListener("storage", storage);
		};
	}, [key, staleMs, opts.intervalMs, ...(opts.deps ?? [])]);
	return {
		data: result.data,
		loading: result.data === null && result.error === null,
		refreshing: state.refreshing,
		error: result.error,
		stale: Boolean(result.error) || (result.data !== null && Date.now() - result.updatedAt >= staleMs),
		refresh: () => runRef.current(true),
	};
}
