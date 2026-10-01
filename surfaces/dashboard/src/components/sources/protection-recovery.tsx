import { GroupLabel, SettingsGroup } from "@/components/settings/controls";
import { useAsync } from "@/lib/use-async";
import { api, type DashboardProtectionReport } from "@/lib/api";
import { protectionSummary } from "@/lib/dashboard-protection";

const COMPONENT_NAMES: Record<string, string> = {
	"root-authored": "Workspace documents",
	skills: "Skills",
	"managed-originals": "Imported original files",
	sqlite: "Memory database",
	transcripts: "Conversation transcripts",
	"external-sources": "Linked external sources",
	runtime: "Runtime files",
	"filesystem-cache": "File cache",
	secrets: "Secrets",
};
const STATE_NAMES: Record<string, string> = {
	protected: "Protected",
	missing: "Missing protection",
	stale: "Out of date",
	degraded: "Needs attention",
	unknown: "Unknown",
	external: "Managed externally",
	unverified: "Not verified",
	"excluded-rebuildable": "Can be rebuilt",
};

export function ProtectionRecoveryPanel({ report }: { report?: DashboardProtectionReport }) {
	const summary = report ? protectionSummary(report) : null;
	return (
		<SettingsGroup aria-label="Protection recovery">
			<GroupLabel>Recovery coverage</GroupLabel>
			<p className="settings-row-description">
				Shows the recovery evidence Signet has for each part of your workspace. “Not verified” means recovery has not
				been confirmed; it does not mean the data is missing.
			</p>
			{!report || !summary ? (
				<p role="status" className="settings-row-description mt-2">
					Recovery information is unavailable from the connected Signet service.
				</p>
			) : (
				<>
					<div className="settings-row">
						<div>
							<div className="settings-row-title">Overall coverage</div>
							<p className="settings-row-description">
								{summary.restore.testedAt
									? `Restore tested ${new Date(summary.restore.testedAt).toLocaleString()} · ${summary.restore.scope ?? "scope unavailable"}`
									: "No verified restore test recorded."}
							</p>
						</div>
						<span className="text-xs text-muted-foreground">
							{report.status === "unknown" || report.status === "unverified"
								? "Recovery not verified"
								: summary.overallLabel}
						</span>
					</div>
					<details className="group mt-2">
						<summary className="flex cursor-pointer list-none items-center justify-between gap-3 py-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring [&::-webkit-details-marker]:hidden">
							View coverage details ({report.components.length})
							<span className="group-open:rotate-90" aria-hidden="true">
								›
							</span>
						</summary>
						<ul aria-label="Protection components" className="mt-2 divide-y divide-border/60">
							{report.components.map((component) => (
								<li key={component.id} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 gap-y-1 py-3">
									<span className="settings-row-title">
										{component.label || COMPONENT_NAMES[component.id] || component.id}
									</span>
									<span className="text-xs text-muted-foreground">
										{STATE_NAMES[component.status] || component.status}
									</span>
									{component.detail && (
										<p className="col-span-2 text-xs leading-relaxed text-muted-foreground">{component.detail}</p>
									)}
								</li>
							))}
						</ul>
					</details>
				</>
			)}
		</SettingsGroup>
	);
}

export function ProtectionRecoveryData() {
	const { data, loading } = useAsync(() => api.getProtection(), { key: "protection", intervalMs: 30000 });
	if (loading && !data)
		return (
			<SettingsGroup title="Recovery coverage">
				<p className="settings-row-description">Loading recovery information…</p>
			</SettingsGroup>
		);
	return <ProtectionRecoveryPanel report={data?.data ?? undefined} />;
}
