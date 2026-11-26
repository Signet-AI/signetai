import {
	Select,
	SelectContent,
	SelectGroup,
	SelectItem,
	SelectLabel,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { useAgentContext, selectAgent } from "@/lib/agent-context";
import { useWhoami } from "@/lib/session";
import { usePanelQuery } from "@/lib/use-panel-query";

interface ContextAgent {
	readonly id: string;
	readonly name: string;
	readonly kind: string;
	readonly ownerUserId: string | null;
	readonly ownerGroupId: string | null;
	readonly archivedAt: string | null;
	readonly canActAs: boolean;
}

export function contextAgentDisplayName(
	agent: { readonly name: string; readonly kind: string },
	organizationName: string,
): string {
	return agent.kind === "organization" && agent.name === "default" ? organizationName : agent.name;
}

export function AgentContextSelect({
	value,
	disabled,
	groups,
	onValueChange,
	placeholder = "Loading agents…",
}: {
	readonly value: string | undefined;
	readonly disabled: boolean;
	readonly groups: readonly {
		readonly label: string;
		readonly agents: readonly { readonly id: string; readonly name: string }[];
	}[];
	readonly onValueChange: (value: string) => void;
	readonly placeholder?: string;
}) {
	return (
		<Select value={value} disabled={disabled} onValueChange={onValueChange}>
			<SelectTrigger className="home-source-filter max-w-full" aria-label="Agent context">
				<SelectValue placeholder={placeholder} />
			</SelectTrigger>
			<SelectContent className="home-source-options" position="popper" align="end" sideOffset={4}>
				{groups
					.filter((group) => group.agents.length > 0)
					.map((group) => (
						<SelectGroup key={group.label}>
							<SelectLabel>{group.label}</SelectLabel>
							{group.agents.map((agent) => (
								<SelectItem key={agent.id} value={agent.id}>
									{agent.name}
								</SelectItem>
							))}
						</SelectGroup>
					))}
			</SelectContent>
		</Select>
	);
}

export function AgentContextSwitcher() {
	const whoami = useWhoami();
	const selected = useAgentContext();
	const { result, refresh } = usePanelQuery<{ agents: readonly ContextAgent[] }>(whoami ? "/api/agents" : null);
	if (!whoami) return null;
	const agents =
		result?.data?.agents
			.filter((agent) => !agent.archivedAt && agent.canActAs)
			.map((agent) => ({ ...agent, name: contextAgentDisplayName(agent, whoami.organization.name) })) ?? [];
	const groups = [
		{ label: "Organization", agents: agents.filter((agent) => agent.kind === "organization") },
		{
			label: "Teams",
			agents: agents.filter(
				(agent) => agent.kind === "team" && whoami.user.groups.some((group) => group.id === agent.ownerGroupId),
			),
		},
		{
			label: "Personal",
			agents: agents.filter((agent) => agent.kind === "personal" && agent.ownerUserId === whoami.user.id),
		},
	];
	return (
		<div className="sig-no-drag flex min-w-0 max-w-24 flex-1 items-center gap-2 sm:max-w-36">
			<AgentContextSelect
				value={selected}
				groups={groups}
				disabled={!result?.data}
				onValueChange={selectAgent}
				placeholder={result?.error ? "Agents unavailable" : "Loading agents…"}
			/>
			{result?.error && (
				<button type="button" className="text-xs underline" onClick={refresh}>
					Retry
				</button>
			)}
		</div>
	);
}
