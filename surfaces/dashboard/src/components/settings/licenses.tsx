import { DASHBOARD_LICENSES } from "@/lib/dashboard-licenses";
import { ExternalLink } from "@/components/mingcute-icons";
import { SettingRow, SettingsGroup } from "./controls";

const INVENTORY_URL = "https://github.com/Signet-AI/signetai/blob/main/THIRD_PARTY_LICENSES.md";

export function LicensesSection() {
	return (
		<div className="flex flex-col gap-3">
			<SettingsGroup title="Open source">
				<p className="settings-row-description">
					Signet’s dashboard uses open-source projects. Thank you to their maintainers and contributors.
				</p>
				<SettingRow title="Signet" desc="Licensed under Apache-2.0.">
					<a
						href={INVENTORY_URL}
						target="_blank"
						rel="noopener noreferrer"
						className="inline-flex items-center gap-2 text-xs text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
					>
						Full dependency inventory <ExternalLink className="size-3.5" aria-hidden="true" />
					</a>
				</SettingRow>
			</SettingsGroup>

			<SettingsGroup title="Dashboard dependencies">
				<p className="settings-row-description mb-2">Includes all external direct runtime + build dependencies.</p>
				<div className="grid gap-x-8 sm:grid-cols-2">
					{DASHBOARD_LICENSES.map((entry) => (
						<a
							key={entry.name}
							href={entry.href}
							target="_blank"
							rel="noopener noreferrer"
							className="group min-w-0 border-b border-border/60 transition-colors hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
						>
							<SettingRow title={entry.name} desc={entry.packages}>
								<span className="inline-flex items-center gap-2 text-xs text-muted-foreground group-hover:text-foreground">
									{entry.license}
									<ExternalLink className="size-3.5 shrink-0" aria-hidden="true" />
								</span>
							</SettingRow>
						</a>
					))}
				</div>
				<p className="settings-row-description mt-3">
					The full dependency inventory includes package versions and license texts; transitive dependency notices are
					not included.
				</p>
			</SettingsGroup>
		</div>
	);
}
