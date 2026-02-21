/**
 * OpenAI SDK adapter for Signet memory.
 *
 * Provides tool definitions compatible with OpenAI's function calling
 * format and a dispatcher for processing tool calls.
 */

import { SignetError } from "./errors.js";
import type { SignetClient } from "./index.js";

interface OpenAIToolDefinition {
  readonly type: "function";
  readonly function: {
    readonly name: string;
    readonly description: string;
    readonly parameters: Record<string, unknown>;
  };
}

export function memoryToolDefinitions(): readonly OpenAIToolDefinition[] {
  return [
    {
      type: "function",
      function: {
        name: "memory_search",
        description: "Search the agent's memory for relevant information",
        parameters: {
          type: "object",
          properties: {
            query: { type: "string", description: "Search query" },
            limit: { type: "number", description: "Max results" },
            type: { type: "string", description: "Memory type filter" },
          },
          required: ["query"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_store",
        description: "Store information in the agent's memory",
        parameters: {
          type: "object",
          properties: {
            content: { type: "string", description: "Content to remember" },
            type: { type: "string", description: "Memory type" },
            importance: { type: "number", description: "0-1 importance" },
          },
          required: ["content"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_modify",
        description: "Modify an existing memory by ID",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Memory ID to modify" },
            content: { type: "string", description: "New content" },
            reason: {
              type: "string",
              description: "Why this change is being made",
            },
            ifVersion: {
              type: "number",
              description: "Optimistic lock version",
            },
          },
          required: ["id", "reason"],
        },
      },
    },
    {
      type: "function",
      function: {
        name: "memory_forget",
        description: "Forget a memory by ID (soft-delete)",
        parameters: {
          type: "object",
          properties: {
            id: { type: "string", description: "Memory ID to forget" },
            reason: {
              type: "string",
              description: "Why this memory is being forgotten",
            },
          },
          required: ["id", "reason"],
        },
      },
    },
  ];
}

function requireString(args: Record<string, unknown>, key: string): string {
  const value = args[key];
  if (typeof value !== "string") {
    throw new SignetError(
      `Expected string for "${key}", got ${typeof value}`,
      "invalid_args",
    );
  }
  return value;
}

function optionalString(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") {
    throw new SignetError(
      `Expected string for "${key}", got ${typeof value}`,
      "invalid_args",
    );
  }
  return value;
}

function optionalNumber(
  args: Record<string, unknown>,
  key: string,
): number | undefined {
  const value = args[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number") {
    throw new SignetError(
      `Expected number for "${key}", got ${typeof value}`,
      "invalid_args",
    );
  }
  return value;
}

export async function executeMemoryTool(
  client: SignetClient,
  toolName: string,
  args: Record<string, unknown>,
): Promise<unknown> {
  switch (toolName) {
    case "memory_search":
      return client.recall(requireString(args, "query"), {
        limit: optionalNumber(args, "limit"),
        type: optionalString(args, "type"),
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
