import { buildContextString, type ProviderPrompts } from "../../types/prompts"

export const SIGNET_PROMPTS: ProviderPrompts = {
  answerPrompt(question: string, context: unknown[], questionDate?: string): string {
    return `You are answering a memory benchmark question using Signet recall results.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Signet Recall Results:
${buildContextString(context)}

Instructions:
- Use only the Signet recall results above.
- Each result may include content, score, source, type, created_at, and metadata.
- Consider temporal/date information when the question asks about order, recency, or updates.
- If the recall results do not contain enough information, answer exactly: I don't know
- Keep the answer concise.

Answer:`
  },
}
