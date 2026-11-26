import { PageHeading } from "@/components/dashboard/heading";
import { SetupRow } from "@/components/home/setup-row";
import { HomeSecretsPanel } from "@/components/home/secrets";
import { OrganizationResource } from "@/views/organization";
import { useView } from "@/lib/view-context";
import type { OrganizationAgent } from "@/lib/organization";
import { agentDisplayName } from "./controls";
import { OrganizationMemory } from "./memory";
import { OrganizationSessions } from "./sessions";

export function OrganizationHome() {
	const { openSettings, setView } = useView();
	return (
		<div className="home-dashboard">
			<div className="home-workspace">
				<section className="home-today" aria-labelledby="today-title">
					<PageHeading
						id="today-title"
						title="Today"
						description="Readable memory and sessions for the selected agent."
					/>
					<OrganizationMemory />
					<OrganizationSessions />
				</section>
				<section className="home-system" aria-labelledby="system-title">
					<PageHeading
						id="system-title"
						title="System"
						level="h2"
						description="Your visible sources, agents, and connected devices."
					/>
					<div className="home-setup-list">
						<OrganizationResource<{ sources: readonly { id: string; name: string }[] }> path="/api/sources">
							{(data) => (
								<SetupRow
									id="org-system-sources"
									label="Sources"
									summary={data.sources.map((source) => source.name).join(", ") || "No readable sources"}
									count={data.sources.length}
									onOpen={() => openSettings("workspace")}
								/>
							)}
						</OrganizationResource>
						<OrganizationResource<{
							devices: readonly { keys: readonly { harness: string | null; revoked_at: string | null }[] }[];
						}> path="/api/auth/devices">
							{(data) => {
								const keys = data.devices.flatMap((device) => device.keys).filter((key) => !key.revoked_at);
								return (
									<SetupRow
										id="org-system-devices"
										label="Devices and connectors"
										summary={
											Array.from(new Set(keys.flatMap((key) => (key.harness ? [key.harness] : [])))).join(", ") ||
											"No connected harnesses"
										}
										count={keys.length}
										onOpen={() => {
											location.hash = "#account/devices";
											setView("account");
										}}
									/>
								);
							}}
						</OrganizationResource>
						<OrganizationResource<{ agents: readonly OrganizationAgent[] }> path="/api/agents">
							{(data) => {
								const visible = data.agents.filter((agent) => agent.canActAs && !agent.archivedAt);
								return (
									<SetupRow
										id="org-system-agents"
										label="Agents"
										summary={visible.map(agentDisplayName).join(", ") || "No available agents"}
										count={visible.length}
										onOpen={() => openSettings("teams")}
									/>
								);
							}}
						</OrganizationResource>
						<HomeSecretsPanel />
					</div>
				</section>
			</div>
		</div>
	);
}
