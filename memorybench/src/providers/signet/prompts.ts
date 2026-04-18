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
3. For temporal questions, pay close attention to dates and time references. Resolve ALL relative dates ("next month", "last week") to absolute dates using the Question Date as anchor.
4. Graph Context (entity relationships) is structurally reliable
5. Knowledge Graph Context provides aggregated cross-referencing — use it to fill gaps

Instructions:
- Base your answer ONLY on the provided memories
- If information can be reasonably inferred from the memories, include it — do not require an exact literal match
- Only say "I don't know" if the memories contain NO relevant information at all
- Be specific: include dates, names, places, and details from the memories
- When multiple memories mention the same topic, combine their details rather than picking just one
- Prefer the most specific version of a fact (e.g. "Sweden" over "home country", "abstract art" over "art")

Answer:
[Your concise, direct answer]`
}

export const SIGNET_PROMPTS: ProviderPrompts = {
  answerPrompt: buildSignetAnswerPrompt,
}

export default SIGNET_PROMPTS
