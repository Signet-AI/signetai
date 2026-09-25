import { Surface } from "@/components/ui/surface";
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
			return "This workspace is selected by SIGNET_PATH or SIGNET_WORKSPACE. Desktop cannot persistently change launcher-provided environment values, so one-click migration is disabled. Remove the override and reopen Signet to migrate the configured workspace.";
		case "external-daemon":
			return "This workspace is running on a daemon started outside Signet Desktop. No migration was started; stop that daemon and reopen Signet Desktop to migrate safely.";
		case "invalid-layout":
			return "The workspace layout could not be read safely. No migration was started.";
		case "unsupported-layout":
			return "This workspace layout is not supported by the automatic migration.";
		case "daemon-unavailable":
			return "The desktop could not verify a daemon for this workspace. Start Signet and try again.";
		case "migration-status-unavailable":
			return "The migration state could not be verified. No migration was started.";
		default:
			return "Workspace migration is unavailable right now.";
	}
}

export function WorkspaceMigrationCard({ placement = "settings" }: { placement?: "notice" | "settings" }) {
	const bridge = getDesktopBridge();
	const query = useAsync(() => bridge?.getWorkspaceMigrationStatus?.() ?? Promise.resolve(null));
	const [running, setRunning] = useState(false);
	const [rollingBack, setRollingBack] = useState(false);
	const [dismissed, setDismissed] = useState(false);
	const [resultMessage, setResultMessage] = useState<string | null>(null);
	const status = query.data;
	const hiddenNotice = placement === "notice" && status ? dismissed || isDismissed(status.appVersion) : false;

	if (placement === "notice" && (!status?.available || hiddenNotice)) return null;

	const startMigration = async () => {
		if (!bridge?.startWorkspaceMigration || running || rollingBack) return;
		setRunning(true);
		setResultMessage(null);
		try {
			const result = await bridge.startWorkspaceMigration();
			if (result.state === "completed") setResultMessage("Migration finished. Signet is restarting into Workspace V2.");
			else if (result.state === "failed")
				setResultMessage(
					"Migration did not finish. Your source files were not deleted; you can retry from Workspace settings.",
				);
			else if (result.state === "blocked") {
				setResultMessage("Migration is blocked. Review the workspace status below and try again.");
				await query.refresh();
			}
		} catch {
			setResultMessage("Migration could not start. No source files were deleted; try again from Workspace settings.");
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
				setResultMessage("The incomplete V2 copy was removed. Your source workspace is unchanged.");
				await query.refresh();
			} else if (result.state === "failed") {
				setResultMessage(
					"Rollback did not finish. Your source workspace is unchanged; review the migration status before retrying.",
				);
				await query.refresh();
			} else {
				setResultMessage("Rollback is currently unavailable. Review the migration status before retrying.");
				await query.refresh();
			}
		} catch {
			setResultMessage(
				"Rollback did not finish. Your source workspace is unchanged; review the migration status before retrying.",
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

	if (placement === "notice") {
		return (
			<Surface
				role="status"
				aria-label="Workspace V2 available"
				className="flex flex-wrap items-center gap-3 border-primary/25 p-4 mb-4"
			>
				<div className="min-w-0 flex-1">
					<div className="text-[13px] font-semibold">Hey, workspace V2 is available.</div>
					<p className="mt-1 mb-0 text-[11px] text-muted-foreground">Would you like to migrate?</p>
				</div>
				<button
					type="button"
					onClick={() => void startMigration()}
					disabled={running || rollingBack || query.loading}
					className="inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
				>
					{running && <Loader2 className="size-3 animate-spin" />}
					{running ? "Migrating…" : "Migrate now"}
				</button>
				<button
					type="button"
					onClick={dismiss}
					className="text-[11px] text-muted-foreground underline underline-offset-4"
				>
					Later
				</button>
				{resultMessage && (
					<p role="status" className="basis-full m-0 text-[11px] text-muted-foreground">
						{resultMessage}
					</p>
				)}
			</Surface>
		);
	}

	return (
		<Surface aria-label="Workspace V2 migration" className="flex flex-col gap-3 p-4">
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
					<div className="text-[14px] font-semibold">Workspace V2</div>
					<p className="mt-1 mb-0 text-[11px] text-muted-foreground">
						{query.loading
							? "Checking workspace status…"
							: !bridge?.getWorkspaceMigrationStatus
								? "One-click migration is available in Signet Desktop."
								: status?.available
									? status.state === "interrupted"
										? "An earlier migration was interrupted. Continue to verify and finish it."
										: "Migrate this workspace to the safer, organized Workspace V2 layout."
									: status?.state === "completed"
										? "Workspace V2 is active."
										: status?.state === "running"
											? "Migration is running. Keep Signet open until it restarts."
											: status?.state === "blocked"
												? blockedMessage(status.reason)
												: "Workspace status is unavailable."}
					</p>
				</div>
			</div>
			{status?.blockers && status.blockers.length > 0 && (
				<ul aria-label="Migration blockers" className="m-0 list-disc pl-5 text-[11px] text-muted-foreground">
					{status.blockers.map((blocker) => (
						<li key={blocker}>{blocker}</li>
					))}
				</ul>
			)}
			{resultMessage && (
				<p role="status" className="m-0 text-[11px] text-muted-foreground">
					{resultMessage}
				</p>
			)}
			{status?.available && (
				<div className="flex flex-wrap items-center gap-3">
					<button
						type="button"
						onClick={() => void startMigration()}
						disabled={running || rollingBack || query.loading}
						className="inline-flex h-8 items-center gap-2 rounded-md bg-primary px-3 text-[11px] font-medium text-primary-foreground disabled:opacity-50"
					>
						{running && <Loader2 className="size-3 animate-spin" />}
						{running ? "Migrating…" : status.state === "interrupted" ? "Continue migration" : "Migrate to Workspace V2"}
					</button>
					<span className="text-[10px] text-muted-foreground">Your source files are retained.</span>
					{status.rollbackAvailable && bridge?.rollbackWorkspaceMigration && (
						<button
							type="button"
							onClick={() => void rollbackMigration()}
							disabled={running || rollingBack || query.loading}
							className="text-[11px] text-muted-foreground underline underline-offset-4 disabled:opacity-50"
						>
							{rollingBack ? "Rolling back…" : "Roll back incomplete copy"}
						</button>
					)}
				</div>
			)}
		</Surface>
	);
}
