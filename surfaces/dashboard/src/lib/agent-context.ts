import { useSyncExternalStore } from "react";
import { currentSession, useWhoami } from "./session";

let selected: { readonly userId: string; readonly agentId: string } | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => {
	listeners.add(listener);
	return () => listeners.delete(listener);
};

export function selectedAgentId(): string | undefined {
	const session = currentSession();
	const whoami = session.kind === "signed-in" ? session.whoami : null;
	if (!whoami) return undefined;
	return (
		whoami.credential.agentId ?? (selected?.userId === whoami.user.id ? selected.agentId : whoami.agents.defaultRead)
	);
}

export function selectAgent(agentId: string): void {
	const session = currentSession();
	if (session.kind !== "signed-in" || !session.whoami || !agentId.trim()) return;
	if (session.whoami.credential.agentId && session.whoami.credential.agentId !== agentId) return;
	selected = { userId: session.whoami.user.id, agentId };
	for (const listener of listeners) listener();
}

export function useAgentContext(): string | undefined {
	useWhoami();
	return useSyncExternalStore(subscribe, selectedAgentId, selectedAgentId);
}
