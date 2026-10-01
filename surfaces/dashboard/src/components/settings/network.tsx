import { ConfigFields } from "./config-fields";
import { useAgentConfig } from "@/lib/agent-config";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";

import { SettingRow, SettingValue, SettingsGroup } from "./controls";
export function NetworkSection() {
	const status = useAsync(() => api.getStatus(), { key: "status" }).data;
	const store = useAgentConfig();
	return (
		<div className="flex flex-col gap-3">
			<SettingsGroup title="Daemon">
				<SettingRow title="Listen port" desc="Port the local daemon serves the dashboard and API on.">
					<SettingValue value={String(status?.port ?? "3850")} sub="localhost" />
				</SettingRow>
				<SettingRow title="Bind address" desc="Restrict the daemon to a specific interface.">
					<SettingValue value={status?.bindHost ?? "127.0.0.1"} />
				</SettingRow>
				<SettingRow title="Network mode" desc="local · tailscale · hybrid">
					<SettingValue value={status?.networkMode ?? "local"} />
				</SettingRow>
			</SettingsGroup>
			<SettingsGroup title="Sync">
				<ConfigFields
					store={store}
					fields={[
						{
							kind: "toggle",
							path: ["git", "enabled"],
							title: "Cloud sync",
							desc: "Encrypted backup of memories, ontology, and skills.",
						},
						{
							kind: "toggle",
							path: ["git", "autoCommit"],
							title: "Auto-commit changes",
							desc: "Debounced git commits on workspace file changes.",
						},
					]}
				/>
			</SettingsGroup>
		</div>
	);
}
