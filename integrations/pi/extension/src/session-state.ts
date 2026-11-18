import {
	emitLifecycleObservation,
	type BaseSessionState,
	BaseSessionStateStore,
	sanitizeInject,
	readTrimmedString,
} from "@signet/pi-extension-base";
import {
	HIDDEN_CONTEXT_CUSTOM_TYPE,
	HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE,
	type PiCustomMessage,
	type PiAgentMessage,
} from "./types.js";

function fence(inject: string): string {
	return `<signet-memory source="auto-recall">\n${sanitizeInject(inject)}\n</signet-memory>`;
}

export interface PiSessionState extends BaseSessionState {
	consumeHiddenInjectMessage(
		sessionId: string | undefined,
		messages: ReadonlyArray<PiAgentMessage>,
	): PiCustomMessage | undefined;
}

class PiSessionStateStore extends BaseSessionStateStore implements PiSessionState {
	consumeHiddenInjectMessage(
		sessionId: string | undefined,
		messages: ReadonlyArray<PiAgentMessage>,
	): PiCustomMessage | undefined {
		if (!sessionId) return;
		if (
			messages.some(
				(message) =>
					message.role === "custom" &&
					(message.customType === HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE ||
						(message.customType === HIDDEN_CONTEXT_CUSTOM_TYPE &&
							typeof message.details === "object" &&
							message.details !== null &&
							"sessionContext" in message.details &&
							message.details.sessionContext === true)),
			)
		) {
			this.clearPendingSessionContext(sessionId);
		}

		const parts: string[] = [];
		const session = readTrimmedString(this.pendingSessionContext.get(sessionId));
		this.pendingSessionContext.delete(sessionId);
		if (session) parts.push(fence(session));

		const recall = this.consumePendingRecall(sessionId);
		if (recall) parts.push(fence(recall));

		const clock = this.consumePendingClock(sessionId);
		if (clock) parts.push(clock);
		if (parts.length === 0) return;

		return {
			customType: HIDDEN_CONTEXT_CUSTOM_TYPE,
			display: false,
			content: parts.join("\n\n"),
			details: { sessionContext: Boolean(session), recall: Boolean(recall), clock: Boolean(clock) },
		};
	}
}

export function createSessionState(): PiSessionState {
	emitLifecycleObservation({ stage: "startup" });
	return new PiSessionStateStore();
}
