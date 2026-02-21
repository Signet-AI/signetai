/**
 * Vercel AI SDK adapter for Signet memory.
 *
 * Provides tool definitions and context injection compatible with
 * the Vercel AI SDK (sdk.vercel.ai). Requires `zod` as a peer dep.
 */

import type { SignetClient } from "./index.js";

// Lazy import so the module loads even without zod installed.
// Callers using this adapter already have zod from the AI SDK.
async function getZod() {
  const z = await import("zod");
  return z;
}

export async function memoryTools(client: SignetClient) {
  const { z } = await getZod();

  return {
    memory_search: {
      description: "Search the agent's memory for relevant information",
      parameters: z.object({
        query: z.string().describe("Search query"),
        limit: z.number().optional().describe("Max results"),
        type: z.string().optional().describe("Memory type filter"),
      }),
      execute: async ({
        query,
        limit,
        type,
      }: {
        query: string;
        limit?: number;
        type?: string;
      }) => {
        return client.recall(query, { limit, type });
      },
    },

    memory_store: {
      description: "Store information in the agent's memory",
      parameters: z.object({
        content: z.string().describe("Content to remember"),
        type: z.string().optional().describe("Memory type"),
        importance: z.number().optional().describe("0-1 importance"),
      }),
      execute: async ({
        content,
        type,
        importance,
      }: {
        content: string;
        type?: string;
        importance?: number;
      }) => {
        return client.remember(content, { type, importance });
      },
    },

    memory_modify: {
      description: "Modify an existing memory by ID",
      parameters: z.object({
        id: z.string().describe("Memory ID to modify"),
        content: z.string().optional().describe("New content"),
        reason: z.string().describe("Why this change is being made"),
        ifVersion: z.number().optional().describe("Optimistic lock version"),
      }),
      execute: async ({
        id,
        content,
        reason,
        ifVersion,
      }: {
        id: string;
        content?: string;
        reason: string;
        ifVersion?: number;
      }) => {
        return client.modifyMemory(id, { content, reason, ifVersion });
      },
    },

    memory_forget: {
      description: "Forget a memory by ID (soft-delete)",
      parameters: z.object({
        id: z.string().describe("Memory ID to forget"),
        reason: z.string().describe("Why this memory is being forgotten"),
      }),
      execute: async ({ id, reason }: { id: string; reason: string }) => {
        return client.forgetMemory(id, { reason });
      },
    },
  };
}

export async function getMemoryContext(
  client: SignetClient,
  userMessage: string,
  opts?: { readonly limit?: number; readonly minScore?: number },
): Promise<string> {
  const results = await client.recall(userMessage, {
    limit: opts?.limit ?? 5,
    minScore: opts?.minScore,
  });

  if (results.results.length === 0) return "";

  const lines = results.results.map((r) => `- ${r.content}`).join("\n");
  return `\n## Relevant Memories\n${lines}\n`;
}
