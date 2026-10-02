export interface AssistantChatMessage {
	readonly role: "user" | "assistant";
	readonly content: string;
}

export type AssistantChatEvent =
	| { readonly type: "delta"; readonly text: string }
	| { readonly type: "tool"; readonly name: string }
	| { readonly type: "retrieval"; readonly nodeIds: readonly string[]; readonly evidenceRefs: readonly string[] }
	| { readonly type: "focus"; readonly entityId: string }
	| { readonly type: "citation"; readonly sourceRef: string; readonly excerpt: string }
	| { readonly type: "saved"; readonly messageIndex: number }
	| { readonly type: "dream"; readonly passId: string }
	| { readonly type: "done"; readonly model: string }
	| { readonly type: "error"; readonly message: string };

function identifiers(value: unknown): value is string[] {
	return (
		Array.isArray(value) &&
		value.length <= 100 &&
		value.every((id) => typeof id === "string" && id.length > 0 && id.length <= 512)
	);
}

export function parseAssistantChatEvent(value: unknown): AssistantChatEvent {
	if (typeof value !== "object" || value === null || !("type" in value)) throw new Error("Invalid assistant event");
	if (
		value.type === "retrieval" &&
		"nodeIds" in value &&
		"evidenceRefs" in value &&
		identifiers(value.nodeIds) &&
		identifiers(value.evidenceRefs)
	)
		return { type: "retrieval", nodeIds: value.nodeIds, evidenceRefs: value.evidenceRefs };
	if (value.type === "delta" && "text" in value && typeof value.text === "string")
		return { type: "delta", text: value.text };
	if (value.type === "tool" && "name" in value && typeof value.name === "string")
		return { type: "tool", name: value.name };
	if (value.type === "focus" && "entityId" in value && typeof value.entityId === "string")
		return { type: "focus", entityId: value.entityId };
	if (
		value.type === "citation" &&
		"sourceRef" in value &&
		typeof value.sourceRef === "string" &&
		"excerpt" in value &&
		typeof value.excerpt === "string"
	)
		return { type: "citation", sourceRef: value.sourceRef, excerpt: value.excerpt };
	if (value.type === "saved" && "messageIndex" in value && typeof value.messageIndex === "number")
		return { type: "saved", messageIndex: value.messageIndex };
	if (value.type === "dream" && "passId" in value && typeof value.passId === "string")
		return { type: "dream", passId: value.passId };
	if (value.type === "done" && "model" in value && typeof value.model === "string")
		return { type: "done", model: value.model };
	if (value.type === "error" && "message" in value && typeof value.message === "string")
		return { type: "error", message: value.message };
	throw new Error("Invalid assistant event");
}
