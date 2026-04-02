import { type BaseSessionState, BaseSessionStateStore, sanitizeInject } from "@signet/extension-base";
import { readTrimmedString } from "@signet/extension-base";
import { HIDDEN_RECALL_CUSTOM_TYPE, HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE, type OmpAgentMessage } from "./types.js";

function createHiddenInjectMessage(customType: string, inject: string): OmpAgentMessage {
	return {
		role: "custom",
		customType,
		display: false,
		content: `<signet-memory source="auto-recall">\n${sanitizeInject(inject)}\n</signet-memory>`,
		attribution: "agent",
		timestamp: Date.now(),
	};
}

function combineHiddenInjects(sessionInject: string | undefined, recallInject: string | undefined): string | undefined {
	const blocks = [readTrimmedString(sessionInject), readTrimmedString(recallInject)].filter(
		(value): value is string => typeof value === "string" && value.length > 0,
	);
	if (blocks.length === 0) return undefined;
	return blocks.join("\n\n");
}

export interface OmpSessionState extends BaseSessionState {
	consumePersistentHiddenInject(sessionId: string | undefined): OmpAgentMessage | undefined;
}

class OmpSessionStateStore extends BaseSessionStateStore implements OmpSessionState {
	consumePersistentHiddenInject(sessionId: string | undefined): OmpAgentMessage | undefined {
		if (!sessionId) return undefined;

		const sessionInject = readTrimmedString(this.pendingSessionContext.get(sessionId));
		this.pendingSessionContext.delete(sessionId);

		const recallInject = this.consumePendingRecall(sessionId);
		const combined = combineHiddenInjects(sessionInject, recallInject);
		if (!combined) return undefined;

		const customType = recallInject ? HIDDEN_RECALL_CUSTOM_TYPE : HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE;
		return createHiddenInjectMessage(customType, combined);
	}
}

export function createSessionState(): OmpSessionState {
	return new OmpSessionStateStore();
}
