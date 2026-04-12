import { type BaseSessionState, BaseSessionStateStore, sanitizeInject } from "@signet/pi-extension-base";
import { readTrimmedString } from "@signet/pi-extension-base";
import { HIDDEN_RECALL_CUSTOM_TYPE, HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE, type PiAgentMessage } from "./types.js";

function createHiddenInjectMessage(customType: string, inject: string): PiAgentMessage {
	return {
		role: "custom",
		customType,
		display: false,
		content: `<signet-memory source="auto-recall">\n${sanitizeInject(inject)}\n</signet-memory>`,
		timestamp: Date.now(),
	};
}

export interface PiSessionState extends BaseSessionState {
	consumeHiddenInjectMessages(sessionId: string | undefined): PiAgentMessage[];
}

class PiSessionStateStore extends BaseSessionStateStore implements PiSessionState {
	consumeHiddenInjectMessages(sessionId: string | undefined): PiAgentMessage[] {
		if (!sessionId) return [];

		const messages: PiAgentMessage[] = [];
		const sessionInject = readTrimmedString(this.pendingSessionContext.get(sessionId));
		if (sessionInject) {
			messages.push(createHiddenInjectMessage(HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE, sessionInject));
		}
		this.pendingSessionContext.delete(sessionId);

		const recallInject = this.consumePendingRecall(sessionId);
		if (recallInject) {
			messages.push(createHiddenInjectMessage(HIDDEN_RECALL_CUSTOM_TYPE, recallInject));
		}

		return messages;
	}
}

export function createSessionState(): PiSessionState {
	return new PiSessionStateStore();
}
