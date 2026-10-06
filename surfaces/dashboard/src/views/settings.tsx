import { NotPermitted } from "@/components/shell/not-permitted";
import { ApiKeysSection } from "@/components/settings/api-keys";
import { ConnectorsSection } from "@/components/settings/connectors";
import { LogsSection } from "@/components/settings/logs";
import { LicensesSection } from "@/components/settings/licenses";
import { SecretsSection } from "@/components/settings/secrets";
import { AdvancedSection } from "@/components/settings/advanced";
import { InferenceSection } from "@/components/settings/inference";
import { NetworkSection } from "@/components/settings/network";
import { WorkspaceSettingsSection } from "@/components/workspace/workspace-settings-section";
import type { SettingsSection } from "@/lib/settings-sections";
import { useCan } from "@/lib/session";
import { useView } from "@/lib/view-context";
import { SearchField } from "@/components/ui/field";
import {
	FolderOpen,
	Link2,
	Globe,
	Sun,
	KeyRound,
	SquareTerminal,
	Settings,
	FileText,
	ShieldCheck,
} from "@/components/mingcute-icons";
import { useEffect, useState } from "react";

const NAV: {
	id: SettingsSection;
	label: string;
	icon: typeof FolderOpen;
	group: "Workspace" | "System";
	keywords: string;
	adminOnly?: boolean;
}[] = [
	{
		id: "workspace",
		label: "Data & files",
		icon: FolderOpen,
		group: "Workspace",
		keywords: "storage files import recovery backup",
	},
	{
		id: "connectors",
		label: "Connectors",
		icon: Link2,
		group: "Workspace",
		keywords: "harness agents integrations connect disconnect",
		adminOnly: true,
	},
	{
		id: "network",
		label: "Network",
		icon: Globe,
		group: "Workspace",
		keywords: "daemon port address sync",
		adminOnly: true,
	},
	{
		id: "inference",
		label: "Inference",
		icon: Sun,
		group: "Workspace",
		keywords: "models providers embeddings api accounts",
		adminOnly: true,
	},
	{
		id: "secrets",
		label: "Secrets",
		icon: KeyRound,
		group: "Workspace",
		keywords: "password keys credentials vault 1password",
		adminOnly: true,
	},
	{
		id: "api-keys",
		label: "API keys",
		icon: ShieldCheck,
		group: "Workspace",
		keywords: "api keys team access teammates tokens revoke connectors",
		adminOnly: true,
	},
	{
		id: "logs",
		label: "Logs",
		icon: SquareTerminal,
		group: "System",
		keywords: "logs telemetry health events",
		adminOnly: true,
	},
	{
		id: "advanced",
		label: "Advanced",
		icon: Settings,
		group: "System",
		keywords: "pipeline dreaming recall privacy telemetry tokens extraction",
		adminOnly: true,
	},
	{
		id: "licenses",
		label: "Licenses",
		icon: FileText,
		group: "System",
		keywords: "licenses attribution dependencies about",
	},
];

export function SettingsView() {
	const { settingsSection: section, openSettings } = useView();
	const isAdmin = useCan("admin");
	const current = NAV.find((n) => n.id === section);
	const [query, setQuery] = useState("");
	const search = query.trim().toLowerCase();
	const visible = NAV.filter((item) => `${item.label} ${item.keywords}`.toLowerCase().includes(search));
	return (
		<section className="settings-page" aria-label="Settings">
			<div className="settings-workspace">
				<nav aria-label="Settings sections" className="settings-section-nav">
					<SearchField
						className="settings-nav-search"
						placeholder="Search"
						aria-label="Search settings"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<div className="settings-nav-groups">
						{(["Workspace", "System"] as const).map((group) => {
							const items = visible.filter((item) => item.group === group);
							if (!items.length) return null;
							return (
								<section className="settings-nav-group" key={group} aria-label={group}>
									<h3 className="settings-nav-group-label">{group}</h3>
									<div className="settings-group-items">
										{items.map((item) => (
											<button
												key={item.id}
												type="button"
												onClick={() => openSettings(item.id)}
												aria-current={section === item.id ? "page" : undefined}
												className="settings-section-link"
											>
												<item.icon className="size-[18px] shrink-0" aria-hidden="true" />
												{item.label}
												{item.adminOnly && !isAdmin && (
													<span className="ml-auto text-[10px] text-muted-foreground">Admin</span>
												)}
											</button>
										))}
									</div>
								</section>
							);
						})}
						{!visible.length && (
							<p className="px-3 text-small text-muted-foreground" role="status">
								No settings found.
							</p>
						)}
					</div>
				</nav>

				<div className="flex min-h-0 min-w-0 flex-1 flex-col">
					<div className="settings-scroll">
						<div className="settings-content">
							<h2 className="settings-title">{current?.label}</h2>
							{current?.adminOnly && !isAdmin ? (
								<NotPermitted what={`${current.label} settings`} permission="admin" className="max-w-xl" />
							) : (
								<>
									{section === "workspace" && <WorkspaceSettingsSection />}
									{section === "connectors" && <ConnectorsSection />}
									{section === "network" && <NetworkSection />}
									{section === "inference" && <InferenceSection />}
									{section === "secrets" && <SecretsSection />}
									{section === "api-keys" && <ApiKeysSection />}
									{section === "logs" && <LogsSection />}
									{section === "advanced" && <AdvancedSection />}
									{section === "licenses" && <LicensesSection />}
								</>
							)}
						</div>
					</div>
				</div>
			</div>
		</section>
	);
}

export function useSettingsHotkey() {
	const { openSettings } = useView();
	useEffect(() => {
		function onKey(e: KeyboardEvent) {
			if (e.key === "," && (e.metaKey || e.ctrlKey)) {
				e.preventDefault();
				openSettings();
			}
		}
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [openSettings]);
}
