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

export function AgentContextSwitcher() {
	const whoami = useWhoami();
	const selected = useAgentContext();
	const { result, refresh } = usePanelQuery<{ agents: readonly ContextAgent[] }>(whoami ? "/api/agents" : null);
	if (!whoami) return null;
	const agents = result?.data?.agents.filter((agent) => !agent.archivedAt && agent.canActAs) ?? [];
	const groups = [
		{ label: "Organization", agents: agents.filter((agent) => agent.kind === "organization") },
		{
			label: "Your teams",
			agents: agents.filter(
				(agent) => agent.kind === "team" && whoami.user.groups.some((group) => group.id === agent.ownerGroupId),
			),
		},
		{
			label: "Your personal agents",
			agents: agents.filter((agent) => agent.kind === "personal" && agent.ownerUserId === whoami.user.id),
		},
	];
	return (
		<div className="sig-no-drag flex min-w-0 items-center gap-2">
			<select
				aria-label="Agent context"
				className="max-w-36 truncate rounded border bg-background px-2 py-1 text-xs text-foreground"
				value={selected ?? ""}
				disabled={!result?.data}
				onChange={(event) => selectAgent(event.target.value)}
			>
				{!result?.data && <option value="">{result?.error ? "Agents unavailable" : "Loading agents…"}</option>}
				{groups.map(
					(group) =>
						group.agents.length > 0 && (
							<optgroup key={group.label} label={group.label}>
								{group.agents.map((agent) => (
									<option key={agent.id} value={agent.id}>
										{agent.name}
										{agent.kind === "organization" ? " (default)" : ""}
									</option>
								))}
							</optgroup>
						),
				)}
			</select>
			{result?.error && (
				<button type="button" className="text-xs underline" onClick={refresh}>
					Retry
				</button>
			)}
		</div>
	);
}
