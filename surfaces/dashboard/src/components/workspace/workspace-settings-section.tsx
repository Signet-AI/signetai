import { ProtectionRecoveryData } from "@/components/sources/protection-recovery";
import { DurableImportStatus } from "@/components/workspace/import-inbox";
import { WorkspaceMigrationCard } from "@/components/workspace/workspace-migration";

export function WorkspaceSettingsSection() {
	return (
		<section aria-label="Workspace settings" className="flex flex-col gap-4">
			<p className="m-0 text-[12px] text-muted-foreground">Workspace layout, migration, import status, and recovery.</p>
			<WorkspaceMigrationCard />
			<DurableImportStatus />
			<ProtectionRecoveryData />
		</section>
	);
}
