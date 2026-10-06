import { ProtectionRecoveryData } from "@/components/sources/protection-recovery";
import { DurableImportStatus } from "@/components/workspace/import-inbox";
import { SettingsGroup } from "@/components/settings/controls";
import { NotPermitted } from "@/components/shell/not-permitted";
import { api } from "@/lib/api";
import { useCan } from "@/lib/session";
import { useAsync } from "@/lib/use-async";

export function WorkspaceSettingsSection() {
	const status = useAsync(() => api.getStatus(), { key: "status", intervalMs: 30_000 });
	const canImport = useCan("modify");
	return (
		<section aria-label="Data & files settings" className="flex flex-col gap-3">
			<SettingsGroup title="Storage location">
				<p className="settings-row-description">
					Your connected Signet service uses this workspace folder for its data and configuration.
				</p>
				{status.data?.agentsDir ? (
					<code className="mt-2 select-text break-all rounded-[var(--radius)] bg-muted/40 p-3 text-xs">
						{status.data.agentsDir}
					</code>
				) : (
					<p role="status" className="settings-row-description mt-2">
						{status.loading ? "Loading workspace location…" : "Could not read the workspace location from Signet."}
					</p>
				)}
				<p className="settings-row-description mt-2">This page does not change your storage location automatically.</p>
			</SettingsGroup>
			<ProtectionRecoveryData />
			{canImport ? <DurableImportStatus /> : <NotPermitted what="Viewing file imports" permission="modify" />}
		</section>
	);
}
