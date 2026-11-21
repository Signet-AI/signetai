import { randomUUID } from "node:crypto";
import type { PiAgentTool } from "../../inference/providers/pi-agent-protocol";

export class DreamingToolScopeError extends Error {
	constructor() {
		super("Tool agent scope must be one of this pass's agents");
		this.name = "DreamingToolScopeError";
	}
}

export interface DreamingPassToolBinding {
	readonly passId: string;
	readonly agentId: string;
	readonly tools: readonly PiAgentTool[];
}

export type DreamingPassToolResult = Readonly<Record<string, unknown>> & { readonly ok: boolean };

export type DreamingPassToolOutcome =
	| { readonly kind: "inactive" }
	| { readonly kind: "forbidden" }
	| { readonly kind: "unknown" }
	| { readonly kind: "result"; readonly result: DreamingPassToolResult };

interface Bound {
	readonly binding: DreamingPassToolBinding;
	readonly calls: Set<Promise<unknown>>;
}

const bound = new Map<string, Bound>();

export function bindDreamingPassTools(binding: DreamingPassToolBinding): () => Promise<void> {
	if (bound.has(binding.passId)) throw new Error(`Dreaming pass ${binding.passId} already has bound tools`);
	const entry: Bound = { binding, calls: new Set() };
	bound.set(binding.passId, entry);
	return async (): Promise<void> => {
		if (bound.get(binding.passId) === entry) bound.delete(binding.passId);
		await Promise.allSettled(entry.calls);
	};
}

function isResult(value: unknown): value is DreamingPassToolResult {
	return (
		typeof value === "object" &&
		value !== null &&
		!Array.isArray(value) &&
		"ok" in value &&
		typeof value.ok === "boolean"
	);
}

async function execute(tool: PiAgentTool, input: Readonly<Record<string, unknown>>): Promise<DreamingPassToolOutcome> {
	try {
		const output = await tool.execute(`http-${randomUUID()}`, input);
		const first = output.content[0];
		const parsed: unknown = first?.type === "text" ? JSON.parse(first.text) : undefined;
		if (!isResult(parsed)) throw new Error(`Dreaming tool ${tool.name} returned no result`);
		return { kind: "result", result: parsed };
	} catch (error) {
		if (error instanceof DreamingToolScopeError) return { kind: "forbidden" };
		throw error;
	}
}

export async function callDreamingPassTool(call: {
	readonly passId: string;
	readonly agentId: string;
	readonly capabilityId: string;
	readonly input: Readonly<Record<string, unknown>>;
}): Promise<DreamingPassToolOutcome> {
	const entry = bound.get(call.passId);
	if (entry === undefined) return { kind: "inactive" };
	if (entry.binding.agentId !== call.agentId) return { kind: "forbidden" };
	const tool = entry.binding.tools.find((candidate) => candidate.name === call.capabilityId);
	if (tool === undefined) return { kind: "unknown" };
	const running = execute(tool, { ...call.input, agentId: call.agentId });
	entry.calls.add(running);
	try {
		return await running;
	} finally {
		entry.calls.delete(running);
	}
}
