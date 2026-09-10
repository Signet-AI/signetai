import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Loader2, RotateCw } from "@/components/mingcute-icons";
import { ConnectorLogo } from "@/components/connector-logo";
import {
	api,
	type ApiReadResult,
	type HarnessActionResponse,
	type HarnessConnector,
	type HarnessConnectorHealth,
	type HarnessConnectorHealthStatus,
	type HarnessesResponse,
} from "@/lib/api";
import { cn } from "@/lib/utils";
import { useEffect, useState } from "react";

type RecoveryAction = "repair" | "reinitialize";

const STATUS_LABELS: Record<HarnessConnectorHealthStatus, string> = {
	healthy: "Healthy",
	degraded: "Degraded",
	unhealthy: "Unhealthy",
	"needs-auth": "Needs auth",
};

const STATUS_CLASSES: Record<HarnessConnectorHealthStatus, string> = {
	healthy: "home-health-healthy",
	degraded: "home-health-degraded",
	unhealthy: "home-health-unhealthy",
	"needs-auth": "home-health-needs-auth",
};

function actionLabel(action: RecoveryAction): string {
	return action === "repair" ? "Repair" : "Reinitialize";
}

function actionProgressLabel(action: RecoveryAction): string {
	return action === "repair" ? "Repairing…" : "Reinitializing…";
}

function errorText(error: unknown, fallback: string): string {
	if (error instanceof Error && error.message.trim()) return error.message;
	if (typeof error === "string" && error.trim()) return error;
	return fallback;
}

function checkedAgo(checkedAt: string): string | null {
	const timestamp = Date.parse(checkedAt);
	if (!Number.isFinite(timestamp)) return null;
	const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1000));
	if (seconds < 5) return "just now";
	if (seconds < 60) return `${seconds}s ago`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.floor(hours / 24)}d ago`;
}

export function HomeConnectorsPanel({
	result,
	loading,
	onRefresh,
}: {
	result: ApiReadResult<HarnessesResponse> | null;
	loading: boolean;
	onRefresh: () => void;
}) {
	const available = result?.data?.connectors;
	const connectors = Array.isArray(available) ? available.filter((connector) => connector.relevant) : [];
	const [activeConnectorId, setActiveConnectorId] = useState<string | null>(null);
	const count = result?.data ? connectors.length : loading ? "loading…" : "—";

	return (
		<section className="home-connectors pb-3" aria-labelledby="home-connectors-title">
			<div className="flex items-baseline justify-between gap-3">
				<div className="flex items-baseline gap-2.5">
					<span id="home-connectors-title" className="text-[15px] font-semibold tracking-tight text-foreground">
						Connectors
					</span>
					<span data-testid="connector-count" className="font-mono text-[10.5px] text-muted-foreground">
						{count}
					</span>
				</div>
			</div>

			{result?.error && (
				<div
					role="alert"
					className="mt-2 flex items-center justify-between gap-2 font-mono text-[10px] text-destructive"
				>
					<span className="min-w-0 truncate" title={result.error}>
						{result.error}
					</span>
					<button type="button" className="home-text-action shrink-0" onClick={() => void onRefresh()}>
						Retry
					</button>
				</div>
			)}

			{loading && result === null ? (
				<div className="grid min-h-[48px] place-items-center font-mono text-[10px] text-muted-foreground">
					Loading connectors…
				</div>
			) : result?.error && !result.data ? (
				<div className="flex min-h-[48px] items-center justify-center gap-2 text-center font-mono text-[10px] text-muted-foreground">
					Unable to load connectors.
				</div>
			) : connectors.length === 0 ? (
				<div className="flex min-h-[48px] items-center font-mono text-[10px] text-muted-foreground">
					No harness connectors installed.
				</div>
			) : (
				<ul className="home-connectors-rows mt-1.5 list-none divide-y divide-border">
					{connectors.map((connector) => (
						<HomeConnectorRow
							key={connector.id}
							connector={connector}
							globallyBusy={activeConnectorId !== null && activeConnectorId !== connector.id}
							onRunning={(running) => setActiveConnectorId(running ? connector.id : null)}
						/>
					))}
				</ul>
			)}
		</section>
	);
}

function HomeConnectorRow({
	connector,
	globallyBusy,
	onRunning,
}: {
	connector: HarnessConnector;
	globallyBusy: boolean;
	onRunning: (running: boolean) => void;
}) {
	const [health, setHealth] = useState<HarnessConnectorHealth>(connector.health);
	const [running, setRunning] = useState<RecoveryAction | null>(null);
	const [confirmationOpen, setConfirmationOpen] = useState(false);
	const [message, setMessage] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setHealth(connector.health);
	}, [connector.health]);

	const execute = async (action: RecoveryAction) => {
		if (running !== null || globallyBusy) return;
		setRunning(action);
		onRunning(true);
		setMessage(null);
		setError(null);

		let failure: string | null = null;
		try {
			let actionResult: ApiReadResult<HarnessActionResponse>;
			try {
				actionResult =
					action === "repair" ? await api.repairHarness(connector.id) : await api.reinitializeHarness(connector.id);
				if (actionResult.error || !actionResult.data) {
					failure = actionResult.error ?? `${actionLabel(action)} failed.`;
				} else {
					setMessage(actionResult.data.message ?? `${actionLabel(action)} completed.`);
				}
			} catch (actionError) {
				failure = errorText(actionError, `${actionLabel(action)} failed.`);
			}

			try {
				const healthResult = await api.getHarnessHealth(connector.id);
				if (healthResult.data) {
					setHealth(healthResult.data.health);
				} else {
					const healthError = healthResult.error ?? "Health check failed.";
					failure = failure ? `${failure} Health check failed: ${healthError}` : `Health check failed: ${healthError}`;
				}
			} catch (healthError) {
				const detail = errorText(healthError, "Health check failed.");
				failure = failure ? `${failure} ${detail}` : detail;
			}
		} finally {
			setRunning(null);
			onRunning(false);
		}

		if (failure) setError(failure);
	};

	const beginAction = (action: RecoveryAction) => {
		if (action === "reinitialize" && connector.capabilities.reinitializeRequiresConfirmation) {
			setConfirmationOpen(true);
			return;
		}
		void execute(action);
	};

	const checked = checkedAgo(health.checkedAt);
	const actionDisabled = running !== null || globallyBusy;
	const label = running ? actionProgressLabel(running) : STATUS_LABELS[health.status];

	return (
		<>
			<li
				className="home-connector-row flex min-w-0 items-center gap-2.5 py-2.5"
				data-health={health.status}
				aria-busy={running !== null}
			>
				<span
					className="home-connector-icon grid size-6 shrink-0 place-items-center text-muted-foreground"
					aria-hidden="true"
				>
					{running ? (
						<Loader2 className="size-4 animate-spin motion-reduce:animate-none" />
					) : (
						<ConnectorLogo icon={connector.icon} className="size-4 object-contain" />
					)}
				</span>
				<div className="min-w-0 flex-1">
					<div className="flex min-w-0 items-center gap-2">
						<span className="min-w-0 truncate text-[13px] text-foreground" title={connector.displayName}>
							{connector.displayName}
						</span>
						<span
							className="hidden shrink-0 truncate font-mono text-[9px] text-muted-foreground/70 sm:inline"
							title={connector.description}
						>
							{connector.description}
						</span>
						<span
							className={cn("flex shrink-0 items-center gap-1 font-mono text-[10px]", STATUS_CLASSES[health.status])}
						>
							<span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
							{label}
						</span>
					</div>
					<div className="truncate font-mono text-[9.5px] text-muted-foreground" title={health.message}>
						{running ? `Checking health after ${actionLabel(running).toLowerCase()}…` : health.message}
						{!running && checked ? <span> · Checked {checked}</span> : null}
					</div>
					{message && !error ? (
						<div role="status" className="truncate font-mono text-[9.5px] text-muted-foreground" title={message}>
							{message}
						</div>
					) : null}
					{error ? (
						<div role="alert" className="truncate font-mono text-[9.5px] text-destructive" title={error}>
							{error}
						</div>
					) : null}
				</div>
				<div className="home-connector-actions flex shrink-0 items-center gap-1">
					{connector.capabilities.repair ? (
						<button
							type="button"
							className="home-connector-action"
							aria-label={`Repair ${connector.displayName}`}
							disabled={actionDisabled}
							onClick={() => beginAction("repair")}
						>
							<RotateCw className={cn("size-3", running === "repair" && "animate-spin motion-reduce:animate-none")} />
							Repair
						</button>
					) : null}
					{connector.capabilities.reinitialize ? (
						<button
							type="button"
							className="home-connector-action"
							aria-label={`Reinitialize ${connector.displayName}`}
							disabled={actionDisabled}
							onClick={() => beginAction("reinitialize")}
						>
							<RotateCw
								className={cn("size-3", running === "reinitialize" && "animate-spin motion-reduce:animate-none")}
							/>
							Reinitialize
						</button>
					) : null}
				</div>
			</li>

			<Dialog
				open={confirmationOpen}
				onOpenChange={(open) => {
					if (running === null) setConfirmationOpen(open);
				}}
			>
				<DialogContent forceMount={confirmationOpen ? true : undefined}>
					<DialogHeader>
						<DialogTitle>Reinitialize {connector.displayName}?</DialogTitle>
						<DialogDescription>
							This reruns the connector initialization path and may update connector-owned configuration files. Signet
							will keep the result and run a health check when it finishes.
						</DialogDescription>
					</DialogHeader>
					<DialogFooter>
						<button
							type="button"
							className="rounded border border-border px-3 py-1 text-sm"
							onClick={() => setConfirmationOpen(false)}
						>
							Cancel
						</button>
						<button
							type="button"
							className="rounded bg-primary px-3 py-1 text-sm text-primary-foreground"
							disabled={running !== null}
							onClick={() => {
								setConfirmationOpen(false);
								void execute("reinitialize");
							}}
						>
							Reinitialize
						</button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
