import { SettingsGroup } from "@/components/settings/controls";
import { Button } from "@/components/ui/button";
import { getDesktopBridge } from "@/lib/desktop";
import { useAsync } from "@/lib/use-async";
import { CheckCircle, FolderOpen, Loader2, TriangleAlert } from "@/components/mingcute-icons";
import { useState } from "react";

function dismissalKey(version: string): string {
	return `signet:workspace-v2-dismissed:${version}`;
}

function isDismissed(version: string): boolean {
	try {
		return window.localStorage.getItem(dismissalKey(version)) === "1";
	} catch {
		return false;
	}
}

function blockedMessage(reason: string | undefined): string {
	switch (reason) {
		case "environment-workspace":
			return "This location is set by SIGNET_PATH or SIGNET_WORKSPACE. Signet Desktop cannot change launch settings. Remove the override, then reopen Signet to move your data.";
		case "external-daemon":
			return "Another Signet process is using this data. No move was started. Stop that process and reopen Signet Desktop to try again.";
		case "invalid-layout":
			return "Signet could not safely check the current files. No move was started.";
		case "unsupported-layout":
			return "These files cannot be moved automatically.";
		case "daemon-unavailable":
			return "Signet could not verify that its background service is ready. Start Signet and try again.";
		case "migration-status-unavailable":
			return "Signet could not verify the move status. No move was started.";
		default:
			return "The storage update is unavailable right now.";
	}
}

export function WorkspaceMigrationCard({
	placement = "settings",
	onlyWhenRelevant = false,
}: {
	placement?: "toast" | "settings";
	onlyWhenRelevant?: boolean;
}) {
	const bridge = getDesktopBridge();
	const query = useAsync(() => bridge?.getWorkspaceMigrationStatus?.() ?? Promise.resolve(null));
	const [running, setRunning] = useState(false);
	const [rollingBack, setRollingBack] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [resultMessage, setResultMessage] = useState<string | null>(null);
	const status = query.data;
	const hiddenNotice = placement === "toast" && status ? dismissed || isDismissed(status.appVersion) : false;

	if (placement === "toast" && (!status?.available || hiddenNotice)) return null;
	if (onlyWhenRelevant && (!bridge?.getWorkspaceMigrationStatus || query.loading || status?.state === "completed"))
		return null;

	const startMigration = async () => {
		if (!bridge?.startWorkspaceMigration || running || rollingBack) return;
		setRunning(true);
		setResultMessage(null);
		try {
			const result = await bridge.startWorkspaceMigration();
			if (result.state === "completed")
				setResultMessage("Signet checked the copy and is restarting with the new storage.");
			else if (result.state === "failed")
				setResultMessage(
					"The move did not finish. Your original files are still in place. Try again in Settings > Data & files.",
				);
			else if (result.state === "blocked") {
				setResultMessage("The move cannot continue. Review the status below and try again.");
				await query.refresh();
			}
		} catch {
			setResultMessage(
				"The move could not start. Your original files are still in place. Try again in Settings > Data & files.",
			);
		} finally {
			setRunning(false);
		}
	};

	const rollbackMigration = async () => {
		if (!bridge?.rollbackWorkspaceMigration || running || rollingBack) return;
		setRollingBack(true);
		setResultMessage(null);
		try {
			const result = await bridge.rollbackWorkspaceMigration();
			if (result.state === "rolled-back") {
				setResultMessage("The incomplete copy was removed. Your original files are unchanged.");
				await query.refresh();
			} else if (result.state === "failed") {
				setResultMessage(
					"The incomplete copy could not be removed. Your original files are unchanged; review the status before retrying.",
				);
				await query.refresh();
			} else {
				setResultMessage("Removing the incomplete copy is unavailable right now. Review the status before retrying.");
				await query.refresh();
			}
		} catch {
			setResultMessage(
				"The incomplete copy could not be removed. Your original files are unchanged; review the status before retrying.",
			);
			await query.refresh();
		} finally {
			setRollingBack(false);
		}
	};

	const dismiss = () => {
		if (status) {
			try {
				window.localStorage.setItem(dismissalKey(status.appVersion), "1");
			} catch {}
		}
		setDismissed(true);
	};

	if (placement === "toast") {
		return (
			<div role="status" aria-label="Signet storage update available" className="sig-storage-strip sig-no-drag">
				<div className="min-w-0 flex-1">
					<span className="text-[12px] font-medium">
						{status?.state === "interrupted" ? "Finish moving your memories and files" : "Move your memories and files"}
					</span>
					<span className="ml-3 hidden text-xs text-muted-foreground lg:inline">
						{status?.state === "interrupted"
							? "The previous move stopped. Signet checks the copy; your original files stay in place."
							: "Signet has a new place to store them. It checks the copy first; your original files stay in place."}
					</span>
				</div>
				<div className="flex shrink-0 items-center gap-3">
					<Button
						variant="default"
						size="compact"
						type="button"
						onClick={() => void startMigration()}
						disabled={running || rollingBack || query.loading}
					>
						{running && <Loader2 className="size-3 animate-spin" />}
						{running ? "Moving…" : status?.state === "interrupted" ? "Continue" : "Move now"}
					</Button>
					<Button variant="link" size="compact" type="button" onClick={dismiss}>
						Later
					</Button>
				</div>
				{resultMessage && (
					<p role="status" className="m-0 w-full text-xs text-muted-foreground">
						{resultMessage}
					</p>
				)}
			</div>
		);
	}

	return (
		<SettingsGroup aria-label="Storage update details" className="gap-3">
			<div className="flex items-start gap-3">
				{status?.state === "completed" ? (
					<CheckCircle className="mt-0.5 size-4 shrink-0 text-emerald-500" />
				) : status?.state === "blocked" ? (
					<TriangleAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
				) : query.loading || running || status?.state === "running" ? (
					<Loader2 className="mt-0.5 size-4 shrink-0 animate-spin text-muted-foreground" />
				) : (
					<FolderOpen className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
				)}
				<div className="min-w-0 flex-1">
					<div className="text-[13px] font-medium">Storage migration</div>
					<p className="mt-1 mb-0 text-xs text-muted-foreground">
						{query.loading
							? "Checking storage status…"
							: !bridge?.getWorkspaceMigrationStatus
								? "Move available in the Signet desktop app."
								: status?.available
									? status.state === "interrupted"
										? "The previous move stopped. Continue so Signet can check the copy and finish the move."
										: "Upgrade this workspace to Signet’s newer storage layout. Signet copies and checks your data before switching, then restarts. Your original files stay in place."
									: status?.state === "completed"
										? "Signet is using the new storage location."
										: status?.state === "running"
											? "The move is running. Keep Signet open until it restarts."
											: status?.state === "blocked"
												? blockedMessage(status.reason)
												: "Storage status is unavailable."}
					</p>
				</div>
			</div>
			{status?.blockers && status.blockers.length > 0 && (
				<ul aria-label="Things to resolve before moving" className="m-0 list-disc pl-5 text-xs text-muted-foreground">
					{status.blockers.map((blocker) => (
						<li key={blocker}>{blocker}</li>
					))}
				</ul>
			)}
			{resultMessage && (
				<p role="status" className="m-0 text-xs text-muted-foreground">
					{resultMessage}
				</p>
			)}
			{status?.available && (
				<div className="flex flex-wrap items-center gap-3">
					<Button
						variant="default"
						size="compact"
						type="button"
						onClick={() => void startMigration()}
						disabled={running || rollingBack || query.loading}
					>
						{running && <Loader2 className="size-3 animate-spin" />}
						{running ? "Moving…" : status.state === "interrupted" ? "Resume migration" : "Migrate storage"}
					</Button>
					<span className="text-[10px] text-muted-foreground">Your original files stay in place.</span>
					{status.rollbackAvailable && bridge?.rollbackWorkspaceMigration && (
						<Button
							variant="link"
							size="compact"
							type="button"
							onClick={() => void rollbackMigration()}
							disabled={running || rollingBack || query.loading}
						>
							{rollingBack ? "Removing copy…" : "Remove incomplete copy"}
						</Button>
					)}
				</div>
			)}
		</SettingsGroup>
	);
}
