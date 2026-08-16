import { type BaseSessionState, BaseSessionStateStore, sanitizeInject } from "@signet/pi-extension-base";
import { readTrimmedString } from "@signet/pi-extension-base";
import {
	HIDDEN_CLOCK_CUSTOM_TYPE,
	HIDDEN_RECALL_CUSTOM_TYPE,
	HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE,
	type OmpAgentMessage,
} from "./types.js";

function createHiddenMessage(customType: string, content: string): OmpAgentMessage {
	return {
		role: "custom",
		customType,
		display: false,
		content,
		attribution: "agent",
		timestamp: Date.now(),
	};
}

function createHiddenInjectMessage(customType: string, inject: string): OmpAgentMessage {
	return createHiddenMessage(
		customType,
		`<signet-memory source="auto-recall">\n${sanitizeInject(inject)}\n</signet-memory>`,
	);
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
	mergeIntoNextPendingRecall(sessionId: string, inject: string): void;
}

class OmpSessionStateStore extends BaseSessionStateStore implements OmpSessionState {
	mergeIntoNextPendingRecall(sessionId: string, inject: string): void {
		const queue = this.pendingRecall.get(sessionId);
		if (!queue || queue.length === 0) {
			this.queuePendingRecall(sessionId, inject);
			return;
		}
		queue[0] = combineHiddenInjects(queue[0], inject) ?? inject;
	}

	consumePersistentHiddenInject(sessionId: string | undefined): OmpAgentMessage | undefined {
		if (!sessionId) return undefined;

		const sessionInject = readTrimmedString(this.pendingSessionContext.get(sessionId));
		this.pendingSessionContext.delete(sessionId);

		const recallInject = this.consumePendingRecall(sessionId);
		const combined = combineHiddenInjects(sessionInject, recallInject);
		const clockContext = this.consumePendingClock(sessionId);
		if (!combined && !clockContext) return undefined;
		if (!combined) return createHiddenMessage(HIDDEN_CLOCK_CUSTOM_TYPE, clockContext ?? "");

		const customType = recallInject ? HIDDEN_RECALL_CUSTOM_TYPE : HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE;
		const injectMessage = createHiddenInjectMessage(customType, combined);
		if (!clockContext) return injectMessage;
		return createHiddenMessage(customType, `${injectMessage.content}\n\n${clockContext}`);
	}
}

export function createSessionState(): OmpSessionState {
	return new OmpSessionStateStore();
}
