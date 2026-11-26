import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import type { ApiReadResult } from "@/lib/api";
import { requestRenewal } from "@/lib/session";

export type PanelState = "loading" | "empty" | "signed-out" | "forbidden" | "degraded" | "ready";

export function panelState<T>(result: ApiReadResult<T> | null, empty: boolean): PanelState {
	if (result === null) return "loading";
	if (result.status === 401) return "signed-out";
	if (result.status === 403) return "forbidden";
	if (result.error || result.data === null) return "degraded";
	return empty ? "empty" : "ready";
}

export function Panel<T>({
	result,
	empty = false,
	emptyMessage = "Nothing here yet.",
	onRetry,
	children,
}: {
	readonly result: ApiReadResult<T> | null;
	readonly empty?: boolean;
	readonly emptyMessage?: string;
	readonly onRetry?: () => void;
	readonly children: (data: T) => ReactNode;
}) {
	const state = panelState(result, empty);
	if (state === "loading")
		return (
			<div role="status" aria-label="Loading" className="space-y-3">
				<Skeleton className="h-5 w-1/2" />
				<Skeleton className="h-20 w-full" />
			</div>
		);
	if (state === "ready" && result?.data !== null && result?.data !== undefined) return children(result.data);
	const message =
		state === "signed-out"
			? "Sign in again to continue. Your place and unsaved input are kept."
			: state === "forbidden"
				? (result?.error ?? "Ask a team owner for access.")
				: state === "empty"
					? emptyMessage
					: `Updates unavailable. ${result?.error ?? "The instance could not be reached."}`;
	return (
		<div
			role="status"
			data-panel-state={state}
			className="flex flex-col gap-3 rounded-lg border border-dashed p-4 text-small text-muted-foreground"
		>
			<p className="m-0">{message}</p>
			{state === "signed-out" && (
				<Button variant="outline" size="sm" className="self-start" onClick={requestRenewal}>
					Sign in
				</Button>
			)}
			{state === "degraded" && onRetry && (
				<Button variant="outline" size="sm" className="self-start" onClick={onRetry}>
					Retry
				</Button>
			)}
		</div>
	);
}
