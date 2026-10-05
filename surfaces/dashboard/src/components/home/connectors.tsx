import { LoadingRows } from "@/components/ui/skeleton";
import { ConnectorLogo } from "@/components/connector-logo";
import { SectionAction, SectionHeading, type StatusTone, StatusLabel } from "@/components/dashboard/heading";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import type { ApiReadResult, HarnessConnector, HarnessesResponse } from "@/lib/api";
import { useView } from "@/lib/view-context";
import { useEffect, useState } from "react";

function installedSnapshot(
	available: readonly HarnessConnector[],
	previous: readonly HarnessConnector[],
): readonly HarnessConnector[] {
	return available.flatMap((connector) => {
		if (!connector.available) {
			const known = previous.find((item) => item.id === connector.id);
			return known ? [{ ...known, inspectionStatus: "unavailable" as const, health: connector.health }] : [];
		}
		return connector.installed ? [connector] : [];
	});
}

export function HomeConnectorsPanel({
	result,
	loading,
}: {
	result: ApiReadResult<HarnessesResponse> | null;
	loading: boolean;
}) {
	const { openSettings } = useView();
	const [previous, setPrevious] = useState<readonly HarnessConnector[]>([]);
	const available = result?.data?.connectors;
	const connectors = available ? installedSnapshot(available, previous) : previous;
	useEffect(() => {
		if (available) setPrevious((known) => installedSnapshot(available, known));
		else if (result === null && !loading) setPrevious([]);
	}, [available, result, loading]);
	const unavailable =
		Boolean(result?.error) ||
		(Boolean(result) && !available) ||
		Boolean(available?.some((item) => !item.available || item.inspectionStatus === "unavailable"));
	const statusOf = (connector: HarnessConnector): { tone: StatusTone; label: string } | null => {
		if (unavailable || !connector.available || connector.inspectionStatus === "unavailable") return null;
		if (connector.health.status === "needs-auth") return { tone: "error", label: "Sign in needed" };
		if (connector.health.status === "degraded" || connector.health.status === "unhealthy")
			return { tone: "warn", label: "Needs attention" };
		return null;
	};
	const exceptions = connectors.flatMap((connector) => {
		const status = statusOf(connector);
		return status ? [{ connector, status }] : [];
	});
	return (
		<section className="home-connectors" aria-labelledby="home-connectors-title">
			<SectionHeading
				id="home-connectors-title"
				title="Connectors"
				meta={
					<span data-testid="connector-count" className="text-meta tabular-nums text-muted-foreground">
						{available || previous.length ? connectors.length : "—"}
					</span>
				}
				actions={<SectionAction onClick={() => openSettings("connectors")}>Manage</SectionAction>}
			/>
			{unavailable && (
				<p role="status" className="mt-2 text-small text-muted-foreground">
					Checks unavailable. Showing the last known installations.
				</p>
			)}
			<div className="mt-3 flex min-w-0 items-center justify-between gap-3 empty:hidden">
				<TooltipProvider delayDuration={150}>
					<ul
						data-testid="connector-rows"
						aria-label="Installed connectors"
						className="home-connectors-rows flex min-w-0 list-none flex-wrap overflow-y-auto empty:hidden"
					>
						{connectors.map((connector) => {
							const label = statusOf(connector)?.label ?? "Installed";
							return (
								<li key={connector.id}>
									<Tooltip>
										<TooltipTrigger asChild>
											<button
												type="button"
												onClick={() => openSettings("connectors")}
												className="home-connector-tile"
												data-tone={statusOf(connector)?.tone}
											>
												<ConnectorLogo icon={connector.icon} className="size-[18px] shrink-0 object-contain" />
												<span className="sr-only">
													{connector.displayName}, {label}
												</span>
											</button>
										</TooltipTrigger>
										<TooltipContent side="bottom">
											{connector.displayName} · {label}
										</TooltipContent>
									</Tooltip>
								</li>
							);
						})}
					</ul>
				</TooltipProvider>
				{connectors.length > 0 && !unavailable && (
					<StatusLabel
						tone={
							exceptions.length
								? exceptions.some((item) => item.status.tone === "error")
									? "error"
									: "warn"
								: "neutral"
						}
					>
						{exceptions.length
							? `${exceptions.length} need${exceptions.length === 1 ? "s" : ""} attention`
							: "All connected"}
					</StatusLabel>
				)}
			</div>
			{exceptions.length > 0 && (
				<ul className="mt-3 flex list-none flex-col gap-1.5" aria-label="Connectors needing attention">
					{exceptions.map(({ connector, status }) => (
						<li key={connector.id} className="flex items-center justify-between gap-3 text-body">
							<span className="truncate">{connector.displayName}</span>
							<StatusLabel tone={status.tone}>{status.label}</StatusLabel>
						</li>
					))}
				</ul>
			)}
			{loading && !connectors.length ? (
				<LoadingRows label="Loading connectors…" rows={2} />
			) : (
				!connectors.length && (
					<p className="mt-2 text-small text-muted-foreground">
						{loading
							? "Loading connectors…"
							: unavailable
								? "Installed connectors could not be checked."
								: "No Signet connectors installed."}
					</p>
				)
			)}
		</section>
	);
}
