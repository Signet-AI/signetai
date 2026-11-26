import { useState } from "react";
import { Attribution } from "@/components/shell/attribution";
import { useWhoami } from "@/lib/session";
import { OrganizationResource } from "@/views/organization";
import { ClassifyAction } from "./classifications";
import { Action, OrganizationBlock, OrganizationTable, cellClass, rowClass } from "./controls";

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
	if (!whoami) return null;
	return (
		<OrganizationBlock title="Sessions">
			<OrganizationResource<{ sessions: readonly SessionRecord[]; count: number }>
				path="/api/sessions"
				empty={(data) => data.count === 0}
			>
				{(data) => (
					<>
						<OrganizationTable columns={["Session", "Attribution", "Harness"]}>
							{data.sessions.map((session) => (
								<tr className={rowClass} key={`${session.agentId}:${session.sessionKey}`}>
									<td className={cellClass}>
										<Action secondary onClick={() => setSelected(session)}>
											{session.sessionKey}
										</Action>
									</td>
									<td className={cellClass}>
										<Attribution author={session.speakerUserId ?? null} agent={session.agentId} />
									</td>
									<td className={cellClass}>{session.harness}</td>
								</tr>
							))}
						</OrganizationTable>
						{selected && (
							<OrganizationBlock title={selected.sessionKey}>
								<ClassifyAction target={{ kind: "session", id: selected.sessionKey, agentId: selected.agentId }} />
								<OrganizationResource<SessionRecord>
									path={`/api/sessions/${encodeURIComponent(selected.sessionKey)}/transcript?agent_id=${encodeURIComponent(selected.agentId)}`}
								>
									{(detail) => (
										<pre className="max-h-64 overflow-auto whitespace-pre-wrap break-words text-small">
											{detail.content ?? "Transcript content unavailable."}
										</pre>
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
