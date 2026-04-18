import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
import type { UnifiedSession } from "../types/unified"

/** Model used for memory extraction */
const EXTRACTION_MODEL = process.env.MEMORYBENCH_EXTRACTION_MODEL || "gpt-4o"

/**
 * Build an extraction prompt that instructs the LLM to extract structured
 * memories from a conversation session. Produces MEMORY.md-style markdown
 * with categorized facts, events, preferences, and relationships.
 */
export function buildExtractionPrompt(session: UnifiedSession): string {
  const speakerA = (session.metadata?.speakerA as string) || "Speaker A"
  const speakerB = (session.metadata?.speakerB as string) || "Speaker B"
  const date =
    (session.metadata?.formattedDate as string) ||
    (session.metadata?.date as string) ||
    "Unknown date"

  const conversation = session.messages
    .map((m) => {
      const speaker = m.speaker || m.role
      const ts = m.timestamp ? ` [${m.timestamp}]` : ""
      return `${speaker}${ts}: ${m.content}`
    })
    .join("\n")

  return `You are a memory extraction system. Read the following conversation and extract all important, memorable information into structured markdown. This will be stored as a memory file for later retrieval.

Conversation Date: ${date}
Participants: ${speakerA}, ${speakerB}

<conversation>
${conversation}
</conversation>

Extract memories into the following structured markdown format. Only include sections that have content.

## Key Facts
- [Personal details, biographical information, skills, jobs, locations, ages, physical descriptions, etc.]

## Preferences
- [Likes, dislikes, preferences, opinions, favorites, etc.]

## Events
- [Computed date]: [Things that happened or were discussed, plans made, activities described]

## Relationships
- [Relationships between people, pets, family members, friends, colleagues, etc.]

## Decisions & Plans
- [Decisions made, future plans, goals, commitments, scheduled events, etc.]

Rules:
- Extract ONLY from what was explicitly stated in the conversation
- Use the speakers' actual names when known, never "the user" or "the assistant"
- Each bullet point should be a self-contained fact (understandable without context)
- For events, always prefix with the computed date in [brackets]
- Do not invent or infer information that was not stated
- If a section would be empty, omit it entirely
- Keep each bullet concise but complete (one line per fact)

Specificity rules:
- Preserve qualifying adjectives and descriptors exactly as stated ("abstract art" not "art", "sunrise painting" not "painting", "Charlotte's Web" not "a book")
- Include counts and quantities ("camped at beach, mountains, and forest" not just "camped at beach")
- List all items when multiple are mentioned, do not summarize a list into a category
- Retain proper nouns, titles, and specific names over generic descriptions

Temporal rules:
- The conversation took place on ${date}
- NEVER leave a relative time reference unresolved. Every "last week", "next month", "this weekend", etc. MUST become an absolute date or date range.
- When a speaker says "last week", compute: one week before ${date}
- When a speaker says "yesterday", compute: one day before ${date}
- When a speaker says "last weekend", compute: the Saturday/Sunday before ${date}
- When a speaker says "last Friday", compute: the most recent Friday before ${date}
- When a speaker says "next month", compute: the calendar month after ${date}
- When a speaker says "next week", compute: the week after ${date}
- When a speaker says "this weekend", compute: the upcoming Saturday/Sunday relative to ${date}
- When a speaker says "in two weeks", compute: two weeks after ${date}
- Always show computed dates as ranges when the exact day is uncertain (e.g. "week of 10 July 2023")
- If the speaker says something happened "on" a specific date, use that date directly
- Never collapse a relative reference to the conversation date itself
- If unsure of the exact day, use the narrowest range possible (e.g. "June 2023" not "sometime in 2023")`
}

/**
 * Call LLM to extract structured memories from a conversation session.
 * Returns MEMORY.md-style markdown with categorized facts, events, preferences.
 */
export async function extractMemories(
  openai: ReturnType<typeof createOpenAI>,
  session: UnifiedSession
): Promise<string> {
  const prompt = buildExtractionPrompt(session)

  const params: Record<string, unknown> = {
    model: openai(EXTRACTION_MODEL),
    prompt,
    maxTokens: 2000,
    temperature: 0,
  }

  const { text } = await generateText(params as Parameters<typeof generateText>[0])

  return text.trim()
}

/** Entity types for structured extraction */
const ENTITY_TYPES = "person, project, system, tool, concept, skill, task, unknown"

/** Aspect categories for structured extraction */
const ASPECT_CATEGORIES =
  "preferences, properties, events, activities, perspectives, relationships, background, decision patterns, general"

/**
 * Build a prompt that extracts structured entities, aspects, and hints
 * from already-extracted markdown memory content.
 */
export function buildStructuredPrompt(content: string): string {
  return `You are a knowledge graph extraction system. Given the following extracted memories, produce a structured JSON object with entities, aspects, and hints.

<memories>
${content}
</memories>

Return a JSON object with this exact schema:

{
  "entities": [
    {"source": "Name", "sourceType": "person", "relationship": "verb phrase", "target": "Name", "targetType": "concept", "confidence": 0.9}
  ],
  "aspects": [
    {"entityName": "Name", "aspect": "category", "attributes": [
      {"content": "factual statement", "confidence": 0.9, "importance": 0.7}
    ]}
  ],
  "hints": [
    "Question this memory could answer?"
  ]
}

Rules:
- Entity types: ${ENTITY_TYPES}
- Aspect categories: ${ASPECT_CATEGORIES}
- Extract ALL entities mentioned (people, places, projects, tools, etc.)
- For each entity, extract relevant aspects with specific factual attributes
- Generate 3-5 diverse hint questions per memory that it could help answer
- Confidence: how certain the information is (0-1)
- Importance: how significant the fact is for future recall (0-1)
- Return ONLY valid JSON, no markdown fences, no explanation`
}

/** Structured extraction result */
interface StructuredExtraction {
  content: string
  structured: {
    entities: Array<{
      source: string
      sourceType?: string
      relationship: string
      target: string
      targetType?: string
      confidence: number
    }>
    aspects: Array<{
      entityName: string
      aspect: string
      attributes: Array<{
        content: string
        confidence?: number
        importance?: number
      }>
    }>
    hints: string[]
  }
}

/** Parse JSON from LLM output, stripping code fences if present */
function parseJson(raw: string): unknown {
  try {
    return JSON.parse(raw)
  } catch {
    const stripped = raw.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "")
    return JSON.parse(stripped)
  }
}

/**
 * Extract both markdown memories and structured knowledge graph data
 * from a conversation session. Calls the LLM twice: once for markdown
 * extraction, once for structured JSON extraction.
 */
export async function extractStructuredMemories(
  openai: ReturnType<typeof createOpenAI>,
  session: UnifiedSession
): Promise<StructuredExtraction> {
  const prompt = buildExtractionPrompt(session)

  const params: Record<string, unknown> = {
    model: openai(EXTRACTION_MODEL),
    prompt,
    maxTokens: 2000,
    temperature: 0,
  }

  const { text } = await generateText(params as Parameters<typeof generateText>[0])
  const content = text.trim()

  const structuredParams: Record<string, unknown> = {
    model: openai(EXTRACTION_MODEL),
    prompt: buildStructuredPrompt(content),
    maxTokens: 3000,
    temperature: 0,
  }

  const { text: raw } = await generateText(structuredParams as Parameters<typeof generateText>[0])

  const fallback = { entities: [], aspects: [], hints: [] }
  let structured: StructuredExtraction["structured"]
  try {
    const parsed = parseJson(raw.trim()) as StructuredExtraction["structured"]
    structured = {
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      aspects: Array.isArray(parsed.aspects) ? parsed.aspects : [],
      hints: Array.isArray(parsed.hints) ? parsed.hints : [],
    }
  } catch {
    structured = fallback
  }

  return { content, structured }
}
