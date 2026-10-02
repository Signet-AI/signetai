import { SignetError } from "./errors.js";
import type { SignetClient } from "./index.js";
import { MEMORY_TOOL_SPECS, type MemoryToolParameterSpec } from "./memory-tools-spec.js";

interface OpenAIToolDefinition {
	readonly type: "function";
	readonly function: {
		readonly name: string;
		readonly description: string;
		readonly parameters: Record<string, unknown>;
	};
}

function buildParameters(properties: Readonly<Record<string, MemoryToolParameterSpec>>): Record<string, unknown> {
	const schemas: Record<string, unknown> = {};
	const required: string[] = [];
	for (const [name, property] of Object.entries(properties)) {
		const schema: Record<string, unknown> = {
			type: property.type === "aggregateBudget" ? "string" : property.type,
			description: property.description,
		};
		if (property.type === "aggregateBudget") schema.enum = ["small", "medium", "large"];
		schemas[name] = schema;
		if (property.required) required.push(name);
	}
	return { type: "object", properties: schemas, required };
}

export function memoryToolDefinitions(): readonly OpenAIToolDefinition[] {
	const definitions: OpenAIToolDefinition[] = [];
	for (const [name, spec] of Object.entries(MEMORY_TOOL_SPECS)) {
		definitions.push({
			type: "function",
			function: {
				name,
				description: spec.description,
				parameters: buildParameters(spec.properties),
			},
		});
	}
	return definitions;
}

function requireString(args: Record<string, unknown>, key: string): string {
	const value = args[key];
	if (typeof value !== "string") {
		throw new SignetError(`Expected string for "${key}", got ${typeof value}`, "invalid_args");
	}
	return value;
}

function optionalString(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "string") {
		throw new SignetError(`Expected string for "${key}", got ${typeof value}`, "invalid_args");
	}
	return value;
}

function optionalNumber(args: Record<string, unknown>, key: string): number | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "number") {
		throw new SignetError(`Expected number for "${key}", got ${typeof value}`, "invalid_args");
	}
	return value;
}

function optionalBoolean(args: Record<string, unknown>, key: string): boolean | undefined {
	const value = args[key];
	if (value === undefined || value === null) return undefined;
	if (typeof value !== "boolean") {
		throw new SignetError(`Expected boolean for "${key}", got ${typeof value}`, "invalid_args");
	}
	return value;
}

function optionalAggregateBudget(args: Record<string, unknown>): "small" | "medium" | "large" | undefined {
	const value = optionalString(args, "aggregateBudget");
	if (value === undefined) return undefined;
	if (value === "small" || value === "medium" || value === "large") return value;
	throw new SignetError("Expected aggregateBudget to be small, medium, or large", "invalid_args");
}

export async function executeMemoryTool(
	client: SignetClient,
	toolName: string,
	args: Record<string, unknown>,
): Promise<unknown> {
	switch (toolName) {
		case "memory_search":
			return client.recall(requireString(args, "query"), {
				recallSurface: "tool_call",
				limit: optionalNumber(args, "limit"),
				type: optionalString(args, "type"),
				aggregate: optionalBoolean(args, "aggregate"),
				aggregateBudget: optionalAggregateBudget(args),
				saveAggregate: optionalBoolean(args, "saveAggregate"),
				...(optionalString(args, "sessionKey") ? { sessionKey: optionalString(args, "sessionKey") } : {}),
				...(optionalString(args, "agentId") ? { agentId: optionalString(args, "agentId") } : {}),
				...(args.includeRecalled === true ? { includeRecalled: true } : {}),
			});

		case "memory_store":
			return client.remember(requireString(args, "content"), {
				type: optionalString(args, "type"),
				importance: optionalNumber(args, "importance"),
			});

		case "memory_modify":
			return client.modifyMemory(requireString(args, "id"), {
				content: optionalString(args, "content"),
				reason: requireString(args, "reason"),
				ifVersion: optionalNumber(args, "ifVersion"),
			});

		case "memory_forget":
			return client.forgetMemory(requireString(args, "id"), {
				reason: requireString(args, "reason"),
			});

		default:
			throw new SignetError(`Unknown tool: ${toolName}`, "unknown_tool");
	}
}
