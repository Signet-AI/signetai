import { ConnectorLogo } from "@/components/connector-logo";
import type { StatusTone } from "@/components/dashboard/heading";
import { ChevronRight } from "@/components/mingcute-icons";
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
	const statusOf = (connector: HarnessConnector) => (unavailable ? null : connectorIssue(connector));
	return (
		<section className="home-setup-group home-connectors" aria-labelledby="home-connectors-title">
			<div className="home-setup-row" data-static="">
				<span id="home-connectors-title" className="home-setup-label">
					Connectors
				</span>
				<span className="home-setup-summary">
					{connectors.length > 0 ? (
						<TooltipProvider delayDuration={150}>
							<ul
								data-testid="connector-rows"
								aria-label="Installed connectors"
								className="home-connectors-rows flex min-w-0 list-none flex-wrap overflow-y-auto"
							>
								{connectors.map((connector) => {
									const status = statusOf(connector);
									const label = status?.label ?? "Installed";
									return (
										<li key={connector.id}>
											<Tooltip>
												<TooltipTrigger asChild>
													<button
														type="button"
														onClick={() => openSettings("connectors")}
														className="home-connector-tile"
														data-tone={status?.tone}
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
					) : loading ? (
						"Loading…"
					) : unavailable ? (
						"Installed connectors could not be checked."
					) : (
						"No Signet connectors installed."
					)}
				</span>
				<span data-testid="connector-count" className="home-setup-count">
					{available || previous.length ? connectors.length : "—"}
				</span>
				<button
					type="button"
					aria-label="Manage connectors"
					onClick={() => openSettings("connectors")}
					className="home-setup-open"
				>
					<ChevronRight className="home-setup-chevron" aria-hidden="true" />
				</button>
			</div>
			{unavailable && (
				<p role="status" className="home-setup-note">
					Checks unavailable. Showing the last known installations.
				</p>
			)}
		</section>
	);
}
export function connectorIssue(connector: HarnessConnector): { tone: StatusTone; label: string } | null {
	if (!connector.installed || !connector.available || connector.inspectionStatus === "unavailable") return null;
	if (connector.health.status === "needs-auth") return { tone: "error", label: "Sign in needed" };
	if (connector.health.status === "degraded" || connector.health.status === "unhealthy")
		return { tone: "warn", label: "Needs attention" };
	return null;
}
