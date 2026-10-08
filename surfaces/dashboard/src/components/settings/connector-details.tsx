import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
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
import { type ReactNode, useEffect, useState } from "react";

type RecoveryAction = "repair" | "reinitialize";

const STATUS_LABELS: Record<HarnessConnectorHealthStatus, string> = {
	healthy: "Installed",
	degraded: "Needs attention",
	unhealthy: "Needs attention",
	"needs-auth": "Sign in needed",
	unknown: "Installed",
};

const STATUS_CLASSES: Record<HarnessConnectorHealthStatus, string> = {
	healthy: "home-health-healthy",
	degraded: "home-health-degraded",
	unhealthy: "home-health-unhealthy",
	"needs-auth": "home-health-needs-auth",
	unknown: "home-health-unknown",
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

export function ConnectorDetailsRow({
	action,
	stale,
	connector,
	globallyBusy,
	onRunning,
}: {
	action?: ReactNode;
	connector: HarnessConnector;
	stale: boolean;
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
	const unavailable = stale || !connector.available || connector.inspectionStatus === "unavailable";
	const needsAttention = !unavailable && health.status !== "healthy" && health.status !== "unknown";
	const actionDisabled = running !== null || globallyBusy || unavailable;
	const label = running
		? actionProgressLabel(running)
		: unavailable
			? "Status unavailable"
			: action && !needsAttention
				? "Connected"
				: STATUS_LABELS[health.status];

	return (
		<>
			<div
				className="home-connector-row"
				data-health={unavailable ? "unknown" : health.status}
				aria-busy={running !== null}
			>
				<details>
					<summary className="flex min-w-0 cursor-pointer items-center gap-3 rounded-md py-3">
						<span
							className="home-connector-icon grid size-9 shrink-0 place-items-center rounded-md bg-muted/40"
							aria-hidden="true"
						>
							<ConnectorLogo icon={connector.icon} className="size-5 object-contain" />
						</span>
						<span className="min-w-0 flex-1">
							<span className="block break-words text-sm font-medium text-foreground">{connector.displayName}</span>
							{!action && (
								<span className="block text-xs leading-relaxed text-muted-foreground">
									{connector.lastSeen
										? `Seen by Signet ${checkedAgo(connector.lastSeen) ?? connector.lastSeen}`
										: "Installation found"}
								</span>
							)}
						</span>
						<span
							className={cn(
								"flex max-w-28 items-center gap-1.5 text-end text-xs",
								needsAttention ? STATUS_CLASSES[health.status] : "text-muted-foreground",
							)}
						>
							{action && !unavailable && !needsAttention && (
								<span className="size-1.5 shrink-0 rounded-full bg-[var(--home-health-healthy)]" aria-hidden="true" />
							)}
							{label}
						</span>
						{action}
						<span className="w-3 shrink-0 text-center text-xs text-muted-foreground" aria-hidden="true">
							⌄
						</span>
					</summary>
					<div className="space-y-3 pb-4 text-xs leading-relaxed text-muted-foreground">
						<p className="m-0">
							{unavailable
								? "A current check is unavailable. This does not indicate a broken connector."
								: health.message}
						</p>
						{!unavailable && checked ? <p className="m-0">Installation checked {checked}.</p> : null}
						{connector.configPath ? <p className="m-0 break-all font-mono">{connector.configPath}</p> : null}
						<div className="flex flex-wrap gap-2">
							{needsAttention && connector.capabilities.repair ? (
								<Button
									variant="outline"
									size="compact"
									type="button"
									aria-label={`Repair ${connector.displayName}`}
									disabled={actionDisabled}
									onClick={() => beginAction("repair")}
								>
									Repair
								</Button>
							) : null}
							{needsAttention && connector.capabilities.reinitialize ? (
								<Button
									variant="outline"
									size="compact"
									type="button"
									aria-label={`Reinitialize ${connector.displayName}`}
									disabled={actionDisabled}
									onClick={() => beginAction("reinitialize")}
								>
									Reinitialize
								</Button>
							) : null}
						</div>
					</div>
				</details>
				{message && !error ? (
					<p role="status" className="text-xs text-muted-foreground">
						{message}
					</p>
				) : null}
				{error ? (
					<p role="alert" className="text-xs text-destructive">
						{error}
					</p>
				) : null}
			</div>

			<ConfirmationDialog
				open={confirmationOpen}
				onOpenChange={(open) => {
					if (running === null) setConfirmationOpen(open);
				}}
				contentProps={{ forceMount: confirmationOpen ? true : undefined }}
				title={<>Reinitialize {connector.displayName}?</>}
				description={
					<>
						This reruns the connector initialization path and may update connector-owned configuration files. Signet
						will keep the result and run a health check when it finishes.
					</>
				}
				actions={
					<>
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
					</>
				}
			/>
		</>
	);
}
