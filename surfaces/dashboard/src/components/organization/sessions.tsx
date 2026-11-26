import { useState } from "react";
import { useWhoami } from "@/lib/session";
import { usePanelQuery } from "@/lib/use-panel-query";
import type { OrganizationAgent } from "@/lib/organization";
import { OrganizationResource } from "@/views/organization";
import { ClassifyAction } from "./classifications";
import { Action, OrganizationBlock, displayLabel, agentDisplayName } from "./controls";
import { EvidenceList } from "./evidence-list";

interface SessionRecord {
	readonly sessionKey: string;
	readonly agentId: string;
	readonly harness: string;
	readonly speakerUserId?: string | null;
	readonly content?: string;
}
export function OrganizationSessions() {
	const whoami = useWhoami();
	const [selected, setSelected] = useState<SessionRecord | null>(null);
	const agents = usePanelQuery<{ agents: readonly OrganizationAgent[] }>(whoami ? "/api/agents" : null);
	if (!whoami) return null;
	return (
		<OrganizationBlock title="Sessions">
			<OrganizationResource<{ sessions: readonly SessionRecord[]; count: number }>
				path="/api/sessions"
				empty={(data) => data.count === 0}
			>
				{(data) => (
					<>
						<EvidenceList
							rows={data.sessions.map((session) => ({
								key: `${session.agentId}:${session.sessionKey}`,
								title: `${displayLabel(session.harness)} session`,
								identifier: session.sessionKey,
								kind: "session",
								agent: agentDisplayName(agents.result?.data?.agents.find((agent) => agent.id === session.agentId)),
								author:
									session.speakerUserId === whoami.user.id
										? whoami.user.displayName
										: session.speakerUserId
											? "Another person"
											: undefined,
								onOpen: () => setSelected(session),
							}))}
						/>
						{selected && (
							<OrganizationBlock title={`${displayLabel(selected.harness)} session`}>
								<p className="text-xs text-muted-foreground">{selected.sessionKey}</p>
								<ClassifyAction target={{ kind: "session", id: selected.sessionKey, agentId: selected.agentId }} />
								<OrganizationResource<SessionRecord>
									path={`/api/sessions/${encodeURIComponent(selected.sessionKey)}/transcript?agent_id=${encodeURIComponent(selected.agentId)}`}
								>
									{(detail) => (
										<div className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-small">
											{detail.content ?? "Transcript content unavailable."}
										</div>
									)}
								</OrganizationResource>
								<Action secondary onClick={() => setSelected(null)}>
									Close session
								</Action>
							</OrganizationBlock>
						)}
					</>
				)}
			</OrganizationResource>
		</OrganizationBlock>
	);
}
