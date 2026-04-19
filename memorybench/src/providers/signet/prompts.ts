import type { ProviderPrompts } from "../../types/prompts"

interface SignetRecallResult {
  content: string
  score: number
  source: string
  type: string
  importance: number
  who: string
  tags: string | null
  project: string | null
  created_at: string
}

function formatResult(result: SignetRecallResult, index: number): string {
  const meta = [
    `score: ${result.score.toFixed(3)}`,
    `source: ${result.source}`,
    `type: ${result.type}`,
  ].join(", ")

  return `[Memory ${index + 1}] (${meta})\n${result.content}`
}

function buildSignetContext(context: unknown[]): {
  traversal: string
  search: string
  graph: string
} {
  const results = context as SignetRecallResult[]
  if (results.length === 0)
    return { traversal: "", search: "No relevant memories were retrieved.", graph: "" }

  const traversalSources = new Set(["traversal", "ka_traversal"])
  const trav = results.filter((r) => traversalSources.has(r.source))
  const flat = results.filter((r) => r.source !== "constructed" && !traversalSources.has(r.source))
  const constructed = results.filter((r) => r.source === "constructed")

  const traversal =
    trav.length > 0 ? trav.map((r, i) => formatResult(r, i)).join("\n\n---\n\n") : ""

  const search =
    flat.length > 0
      ? flat.map((r, i) => formatResult(r, trav.length + i)).join("\n\n---\n\n")
      : "No search matches found."

  const graph =
    constructed.length > 0
      ? constructed
          .map((r, i) => formatResult(r, trav.length + flat.length + i))
          .join("\n\n---\n\n")
      : ""

  return { traversal, search, graph }
}

export function buildSignetAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const { traversal, search, graph } = buildSignetContext(context)

  const traversalSection = traversal
    ? `\nGraph Context (structurally retrieved via entity relationships — high confidence):\n${traversal}\n`
    : ""

  const graphSection = graph
    ? `\n\nKnowledge Graph Context (aggregated entity facts — use for cross-referencing):\n${graph}`
    : ""

  return `You are a question-answering system. Based on the retrieved memories below, answer the question.

Question: ${question}
Question Date: ${questionDate || "Not specified"}
${traversalSection}
Search Context (retrieved via text similarity):
${search}${graphSection}

**How to Answer:**
1. For simple factual questions, a single matching memory is sufficient — give a direct answer
2. For multi-hop questions, synthesize across multiple memories
3. For temporal questions, pay close attention to dates and time references. Resolve ALL relative dates ("next month", "last week") to absolute dates using the memory date or Question Date as anchor.
4. When comparing relative lookbacks from the same anchor date, the longer lookback happened earlier (for example, "about a month ago" is earlier than "about three weeks ago").
5. If an older memory gives a count and a newer memory says the user added one or more items to the same collection, compute the current count instead of repeating the older count.
6. If a memory includes a [Signet currentness] note, treat superseded structured facts as historical and prefer the listed current replacement or current structured fact.
7. Graph Context (entity relationships) is structurally reliable
8. Knowledge Graph Context provides aggregated cross-referencing — use it to fill gaps
9. Transcript excerpts are lossless source snippets for retrieved sessions. Use them to recover exact names, counts, and dates that the extracted memory summary may have compressed.
10. For preference or advice questions, use retrieved preferences as grounding and give a concrete personalized suggestion. Do not merely repeat the user's known preference back to them.
11. If the question asks for advice about something the memories say the user already tried or already likes, treat that as the starting point. Recommend a next step, pairing, variation, or technique that builds on it.

Instructions:
- Base your answer ONLY on the provided memories
- If information can be reasonably inferred from the memories, include it — do not require an exact literal match
- Only say "I don't know" if the memories contain NO relevant information at all
- Be specific: include dates, names, places, and details from the memories
- When multiple memories mention the same topic, combine their details, but use the newest/current fact when the memories conflict
- Prefer the most specific version of a fact (e.g. "Sweden" over "home country", "abstract art" over "art")

Answer:
[Your concise, direct answer]`
}

export function buildSignetSupermemoryParityAnswerPrompt(
  question: string,
  context: unknown[],
  questionDate?: string
): string {
  const { search } = buildSignetContext(context)

  return `You are a question-answering system. Based on the retrieved context below, answer the question.

Question: ${question}
Question Date: ${questionDate || "Not specified"}

Retrieved Context:
${search}

**Understanding the Context:**
The retrieved Signet memories were ingested in Supermemory-parity mode. Each memory contains the same raw session shape that the upstream Supermemory adapter stores: a date header followed by a stringified JSON conversation.

1. The memory content is the raw source material for the session.
2. The date header is the session date. Use it to resolve relative time references.
3. Read the stringified JSON messages carefully for specific named services, products, people, places, and dates.
4. When comparing relative lookbacks from the same anchor date, the longer lookback happened earlier (for example, "about a month ago" is earlier than "about three weeks ago").

Instructions:
- Base your answer ONLY on the provided context.
- If the context contains enough information, provide a concise direct answer.
- If the context does not contain enough information, respond with "I don't know".
- Be specific and preserve names exactly.

Answer:
[Your concise, direct answer]`
}

export const SIGNET_PROMPTS: ProviderPrompts = {
  answerPrompt: buildSignetAnswerPrompt,
}

export const SIGNET_SUPERMEMORY_PARITY_PROMPTS: ProviderPrompts = {
  answerPrompt: buildSignetSupermemoryParityAnswerPrompt,
}

export default SIGNET_PROMPTS
