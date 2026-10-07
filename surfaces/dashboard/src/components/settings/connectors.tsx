import { LoadingRows } from "@/components/ui/skeleton";
import { useState } from "react";
import { ConnectorLogo } from "@/components/connector-logo";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import { api, type HarnessConnector } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { SettingsGroup } from "./controls";
import { ConnectorDetailsRow } from "./connector-details";

export function ConnectorsSection() {
	const query = useAsync(() => api.getHarnesses(), { key: "harnesses", intervalMs: 30_000 });
	const [busy, setBusy] = useState<string | null>(null);
	const [disconnect, setDisconnect] = useState<HarnessConnector | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [message, setMessage] = useState<string | null>(null);
	const connectors = query.data?.data?.connectors ?? [];
	const act = async (id: string, action: "connect" | "disconnect") => {
		if (busy) return;
		setBusy(id);
		setError(null);
		setMessage(null);
		try {
			const result = action === "connect" ? await api.connectHarness(id) : await api.disconnectHarness(id);
			if (result.error || !result.data?.success) setError(result.error ?? `Could not ${action} this connector.`);
			else setMessage(action === "connect" ? "Signet integration connected." : "Signet integration disconnected.");
			await query.refresh();
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : `Could not ${action} this connector.`);
		} finally {
			setBusy(null);
		}
	};
	return (
		<div className="space-y-6">
			<p className="settings-row-description">
				Manage Signet integrations for the agents on this machine. Install an agent first, then connect it here.
			</p>
			{query.data?.error && (
				<p role="alert" className="text-sm text-muted-foreground">
					Connector checks are unavailable. Try again when the daemon responds.
				</p>
			)}
			{error && (
				<p role="alert" className="text-sm text-destructive">
					{error}
				</p>
			)}
			{message && (
				<p role="status" className="text-sm text-muted-foreground">
					{message}
				</p>
			)}
			<SettingsGroup>
				{query.loading && !connectors.length ? (
					<LoadingRows label="Loading connectors…" rows={6} />
				) : (
					!connectors.length && (
						<p className="py-4 text-sm text-muted-foreground">
							{query.loading ? "Loading connectors…" : "Installations could not be checked."}
						</p>
					)
				)}
				<ul className="list-none divide-y divide-border">
					{connectors.map((connector) => {
						const button = (
							<Button
								variant={connector.installed ? "ghost" : "outline"}
								size="compact"
								className={connector.installed ? "settings-quiet-action shrink-0" : "shrink-0"}
								disabled={busy !== null || !connector.available || Boolean(query.data?.error)}
								onClick={(event) => {
									event.preventDefault();
									event.stopPropagation();
									if (connector.installed) setDisconnect(connector);
									else void act(connector.id, "connect");
								}}
							>
								{busy === connector.id ? "Working…" : connector.installed ? "Disconnect" : "Connect"}
							</Button>
						);
						return (
							<li key={connector.id} className="settings-connector">
								{connector.installed ? (
									<ConnectorDetailsRow
										connector={connector}
										stale={Boolean(query.data?.error)}
										globallyBusy={busy !== null}
										onRunning={(running) => setBusy(running ? connector.id : null)}
										action={button}
									/>
								) : (
									<div className="flex min-w-0 items-center gap-3 py-3">
										<span className="grid size-9 shrink-0 place-items-center rounded-md bg-muted/40">
											<ConnectorLogo icon={connector.icon} className="size-5 object-contain" />
										</span>
										<span className="min-w-0 flex-1 text-sm font-medium">{connector.displayName}</span>
										<span className="max-w-28 text-end text-xs text-muted-foreground">
											{!connector.available ? "Check unavailable" : "Not connected"}
										</span>
										{button}
										<span className="w-3 shrink-0" aria-hidden="true" />
									</div>
								)}
							</li>
						);
					})}
				</ul>
			</SettingsGroup>
			<ConfirmationDialog
				open={disconnect !== null}
				onOpenChange={(open) => {
					if (!open) setDisconnect(null);
				}}
				title={<>Disconnect {disconnect?.displayName}?</>}
				description={
					<>
						Remove this harness’s Signet integration. Your memories stay in Signet. You can connect the harness again
						here.
					</>
				}
				actions={
					<>
						<Button variant="outline" onClick={() => setDisconnect(null)}>
							Cancel
						</Button>
						<Button
							onClick={() => {
								if (disconnect) {
									const id = disconnect.id;
									setDisconnect(null);
									void act(id, "disconnect");
								}
							}}
						>
							Disconnect
						</Button>
					</>
				}
			/>
		</div>
	);
}
