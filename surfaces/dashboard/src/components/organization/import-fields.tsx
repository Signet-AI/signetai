import { Panel } from "@/components/shell/panel";
import { useWhoami } from "@/lib/session";
import { usePanelQuery } from "@/lib/use-panel-query";
import type { OrganizationAgent, OrganizationClassification } from "@/lib/organization";
import { agentDisplayName, Choice } from "./controls";

export function OrganizationImportFields({
	agentId,
	classification,
	onAgentChange,
	onClassificationChange,
	disabled,
}: {
	agentId: string;
	classification: string;
	onAgentChange: (value: string) => void;
	onClassificationChange: (value: string) => void;
	disabled: boolean;
}) {
	const whoami = useWhoami();
	const agents = usePanelQuery<{ agents: readonly OrganizationAgent[] }>(whoami ? "/api/agents" : null);
	const definitions = usePanelQuery<readonly OrganizationClassification[]>(whoami ? "/api/classifications" : null);
	if (!whoami) return null;
	return (
		<fieldset disabled={disabled} className="flex min-w-0 flex-col gap-3">
			<legend className="sr-only">Import destination</legend>
			<Panel result={agents.result} onRetry={agents.refresh}>
				{(data) => (
					<Choice
						label="Import agent"
						value={agentId}
						onChange={onAgentChange}
						options={[
							{ value: "", label: "Choose an agent" },
							...data.agents
								.filter(
									(agent) =>
										agent.canActAs &&
										!agent.archivedAt &&
										(!whoami.credential.agentId || agent.id === whoami.credential.agentId) &&
										(agent.id !== "default" || whoami.organization.agentModel === "single"),
								)
								.map((agent) => ({ value: agent.id, label: agentDisplayName(agent) })),
						]}
					/>
				)}
			</Panel>
			<Panel result={definitions.result} onRetry={definitions.refresh}>
				{(data) => (
					<Choice
						label="Import classification"
						value={classification}
						onChange={onClassificationChange}
						options={[
							{ value: "", label: "Choose a classification" },
							{ value: "none", label: "No classification" },
							...data.filter((item) => !item.archived_at).map((item) => ({ value: item.id, label: item.name })),
						]}
					/>
				)}
			</Panel>
			<p className="settings-row-description">
				The daemon applies ownership and classification before imported material is available to readers.
			</p>
		</fieldset>
	);
}
