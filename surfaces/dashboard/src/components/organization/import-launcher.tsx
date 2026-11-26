import { useState } from "react";
import { SettingsGroup } from "@/components/settings/controls";
import { ConnectSourceDialog } from "@/components/sources/connect-source-dialog";
import { Button } from "@/components/ui/button";
import { NotPermitted } from "@/components/shell/not-permitted";
import { useCan } from "@/lib/session";

export function OrganizationImportLauncher({ onImported }: { onImported: () => void }) {
	const [open, setOpen] = useState(false);
	const allowed = useCan("documents");
	if (!allowed) return <NotPermitted what="Importing files" permission="documents" />;
	return (
		<SettingsGroup title="Import files and transcripts">
			<p className="settings-row-description">
				Choose who owns the imported material and who may read it before uploading.
			</p>
			<Button size="compact" className="self-start" onClick={() => setOpen(true)}>
				Import files or transcripts
			</Button>
			<ConnectSourceDialog open={open} onClose={() => setOpen(false)} onConnected={onImported} />
		</SettingsGroup>
	);
}
