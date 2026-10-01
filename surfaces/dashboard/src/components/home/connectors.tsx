import { LoadingRows } from "@/components/ui/skeleton";
import { ConnectorLogo } from "@/components/connector-logo";
import { ChevronRight } from "@/components/mingcute-icons";
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
	return (
		<section className="home-connectors pb-3" aria-labelledby="home-connectors-title">
			<button
				type="button"
				onClick={() => openSettings("connectors")}
				className="group flex w-full items-center justify-between gap-3 py-2 text-left"
			>
				<span id="home-connectors-title" className="text-[14px] font-medium tracking-tight">
					Connectors{" "}
					<span
						data-testid="connector-count"
						className="ml-2 font-mono text-[10.5px] font-normal text-muted-foreground"
					>
						{available || previous.length ? connectors.length : "—"}
					</span>
				</span>
				<span className="flex items-center gap-2 text-xs text-muted-foreground">
					Connect & manage <ChevronRight className="size-3.5" />
				</span>
			</button>
			<p className="mb-3 text-xs text-muted-foreground">Signet integrations installed on this machine.</p>
			{unavailable && (
				<p role="status" className="mb-3 text-xs text-muted-foreground">
					Checks unavailable. Showing the last known installations.
				</p>
			)}
			<ul
				data-testid="connector-rows"
				aria-label="Installed connectors"
				className="overflow-y-auto home-connectors-rows list-none divide-y divide-border"
			>
				{connectors.map((connector) => (
					<li key={connector.id}>
						<button
							type="button"
							onClick={() => openSettings("connectors")}
							className="home-connector-link flex w-full items-center gap-3 rounded-[var(--control-radius)] py-3 text-left"
						>
							<ConnectorLogo icon={connector.icon} className="size-5 shrink-0 object-contain" />
							<span className="flex-1 text-[13px]">{connector.displayName}</span>
							<span className="text-xs text-muted-foreground">
								{!unavailable &&
								connector.available &&
								connector.inspectionStatus !== "unavailable" &&
								connector.health.status === "needs-auth"
									? "Sign in needed"
									: !unavailable &&
											connector.available &&
											connector.inspectionStatus !== "unavailable" &&
											["degraded", "unhealthy"].includes(connector.health.status)
										? "Needs attention"
										: "Installed"}
							</span>
						</button>
					</li>
				))}
			</ul>
			{loading && !connectors.length ? (
				<LoadingRows label="Loading connectors…" rows={2} />
			) : (
				!connectors.length && (
					<p className="py-3 text-sm text-muted-foreground">
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
