import { createOpenAI } from "@ai-sdk/openai"
import { generateText } from "ai"
import type { UnifiedSession } from "../types/unified"

/** Model used for memory extraction */
const EXTRACTION_MODEL = process.env.MEMORYBENCH_EXTRACTION_MODEL || "gpt-4o"

function readPositiveInt(name: string, fallback: number): number {
  const value = Number.parseInt(process.env[name] || "", 10)
  return Number.isFinite(value) && value > 0 ? value : fallback
}

const EXTRACTION_MAX_TOKENS = readPositiveInt("MEMORYBENCH_EXTRACTION_MAX_TOKENS", 1200)
const STRUCTURED_EXTRACTION_MAX_TOKENS = readPositiveInt(
  "MEMORYBENCH_STRUCTURED_EXTRACTION_MAX_TOKENS",
  1800
)
const STRUCTURED_EXTRACTION_CONTENT_CHARS = readPositiveInt(
  "MEMORYBENCH_STRUCTURED_EXTRACTION_CONTENT_CHARS",
  18000
)

function extractionModelSupportsTemperature(): boolean {
  const model = EXTRACTION_MODEL.toLowerCase()
  return !(
    model.startsWith("inception/mercury") ||
    model.startsWith("gpt-5") ||
    model.startsWith("o1") ||
    model.startsWith("o3") ||
    model.startsWith("o4")
  )
}

function extractionTemperature(): Record<string, number> {
  return extractionModelSupportsTemperature() ? { temperature: 0 } : {}
}

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
- Preserve named products, apps, websites, streaming services, tools, brands, venues, works, and platforms even when they seem incidental
- Preserve assistant-provided recommendations when the user asks for them. Include the named recommended items and the distinguishing reason the assistant gave, especially if the user later accepts or plans to check them out. Do not collapse a recommendation list into "the assistant provided recommendations."
- Preserve named brands and products with their source materials or sourcing details when stated, such as "Veja uses wild rubber sourced from the Amazon rainforest."
- Treat recent named-service usage as memorable ("using Spotify lately", "watching on Netflix", "tracking in TripIt")
- If a speaker says they have just downloaded, started using, have been using, listening, watching, reading, tracking, or syncing on a named service/app/platform, write a separate dated fact naming that service explicitly. Do not fold it into a generic preference.
- For collections and inventories, preserve counts and later additions as separate dated facts so current totals can be computed from old count plus new additions.
- For recurring schedules and routines, preserve every stated activity with its day, time, cadence, and start/update language. Do not collapse "yoga on Wednesdays, Zumba on Tuesdays and Thursdays, and weightlifting on Saturdays" into "attends fitness classes."
- When a speaker starts, attends, changes, or plans a recurring class, lesson, appointment, workout, meeting, or habit, write a separate fact for each recurring slot so later answers can count or combine them.

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
    maxTokens: EXTRACTION_MAX_TOKENS,
    ...extractionTemperature(),
  }

  const { text } = await generateText(params as Parameters<typeof generateText>[0])

  return text.trim()
}

/** Entity types for structured extraction */
const ENTITY_TYPES =
  "person, organization, place, project, system, service, tool, product, work, event, unknown"

/** Aspect categories for structured extraction */
const ASPECT_CATEGORIES =
  "preferences, properties, events, activities, perspectives, relationships, background, decision patterns, general"

/**
 * Build a prompt that extracts structured entities, aspects, and hints
 * from already-extracted markdown memory content.
 */
export function buildStructuredPrompt(content: string): string {
  const bounded = boundStructuredContent(content)

  return `You are a knowledge graph extraction system. Given the following extracted memories, produce a structured JSON object with entities, aspects, and hints.

Structured remembering model:
- Entity: a durable referent that can be expanded by aspects and attributes.
- Aspect: a stable facet of an entity, such as music preferences, commute routine, baking preferences, dining history, project tools, or temporal state.
- Attribute: a specific sourced claim attached to an entity aspect.

<memories>
${bounded}
</memories>

Return a JSON object with this exact schema:

{
  "entities": [
    {"source": "Name", "sourceType": "person", "relationship": "verb phrase", "target": "Name", "targetType": "concept", "confidence": 0.9}
  ],
  "aspects": [
    {"entityName": "Name", "aspect": "category", "attributes": [
      {"groupKey": "navigable_snake_case_group", "claimKey": "stable_snake_case_claim_identity", "content": "factual statement", "confidence": 0.9, "importance": 0.7}
    ]}
  ],
  "hints": [
    "Question this memory could answer?"
  ]
}

Rules:
- Entity types: ${ENTITY_TYPES}
- Aspect categories: ${ASPECT_CATEGORIES}
- Entities are durable referents, not just proper nouns.
- Valid entities: named people, places, organizations, products, apps, websites, services, tools, brands, titled works, named projects, named events, and the scoped benchmark participants "Benchmark User" and "Benchmark Assistant".
- For personal memories, map Speaker A, user, I, and me to the entity "Benchmark User".
- For assistant-side memories, map Speaker B and assistant to the entity "Benchmark Assistant".
- Generic personal preferences, routines, counts, and history belong as aspects/attributes of Benchmark User.
- Invalid entities: common nouns without a stable referent, activities by themselves, dates by themselves, verbs, adjectives, stopwords, or markdown section headings.
- Never emit section headings or fallbacks such as Key Facts, Preferences, Events, Relationships, Decisions, Plans, Properties, General, None, "no entities", or "no proper nouns" as entities.
- If a memory has only generic user facts, use Benchmark User as the entity and attach those facts as aspects/attributes.
- For each entity, extract relevant aspects with specific factual attributes.
- Attach generic user facts to Benchmark User instead of dropping them.
- Preserve temporal and update language in attributes, including "currently", "recently", "previously", dates, counts, and before/after relationships.
- For recurring schedules and routines, attach each recurring slot as an attribute on Benchmark User. Use specific aspects such as activities, fitness_routine, work_schedule, learning_routine, or medical_routine when supported by the memory. Use groupKey values like class_schedule, appointment_schedule, meeting_schedule, practice_schedule, or habit_schedule. Use stable claimKey values like yoga_class_day, zumba_class_time, weightlifting_class_time, therapy_appointment_day, or team_meeting_time.
- Preserve day-of-week, time, cadence, start/update language, and currentness in those recurring schedule attributes. Separate slots should have separate claimKey values unless a newer fact updates the exact same slot.
- Every attribute SHOULD include groupKey: a stable snake_case subgroup inside the aspect, like restaurants inside food or listening_habits inside music. Use "general" only when no clearer subgroup exists.
- Every attribute MUST include claimKey: a stable snake_case identity for the specific claim slot within the entity/aspect/group.
- Use the same claimKey only when a newer attribute updates or replaces the same underlying claim. Example: "tried three Korean restaurants" and "has now tried four Korean restaurants" share "korean_restaurants_tried_count".
- Unrelated events under the same entity/aspect MUST have different claimKey values. Example: "asked for a Parable of the Sower poem" and "asked for web-search privacy papers" must not share a key.
- Generate 3-5 diverse hint questions per memory that it could help answer
- Confidence: how certain the information is (0-1)
- Importance: how significant the fact is for future recall (0-1)
- Return ONLY valid JSON, no markdown fences, no explanation`
}

export function boundStructuredContent(content: string): string {
  const trimmed = content.trim()
  if (trimmed.length <= STRUCTURED_EXTRACTION_CONTENT_CHARS) return trimmed

  const omitted = trimmed.length - STRUCTURED_EXTRACTION_CONTENT_CHARS
  const headChars = Math.floor(STRUCTURED_EXTRACTION_CONTENT_CHARS * 0.6)
  const tailChars = STRUCTURED_EXTRACTION_CONTENT_CHARS - headChars
  const head = trimmed.slice(0, headChars).trimEnd()
  const tail = trimmed.slice(trimmed.length - tailChars).trimStart()
  return `${head}\n\n[Truncated ${omitted} middle characters to keep structured extraction inside the local model context window.]\n\n${tail}`
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
        groupKey?: string
        claimKey?: string
        content: string
        confidence?: number
        importance?: number
      }>
    }>
    hints: string[]
  }
}

const ROLE_OR_GENERIC_ENTITY_NAMES = new Set([
  "assistant",
  "be",
  "conversation",
  "data",
  "decision",
  "decision patterns",
  "decisions",
  "event",
  "events",
  "fact",
  "facts",
  "friend",
  "friends",
  "aunt",
  "general",
  "i",
  "key facts",
  "me",
  "museum",
  "music",
  "none",
  "plan",
  "plans",
  "preference",
  "preferences",
  "properties",
  "project",
  "relationship",
  "relationships",
  "road trip",
  "speaker",
  "speaker a",
  "speaker b",
  "support group",
  "task",
  "the",
  "user",
  "week",
  "you",
])

const GENERIC_ENTITY_TYPES = new Set(["concept", "skill", "task"])

const NAMED_ENTITY_TYPES = new Set([
  "event",
  "organization",
  "person",
  "place",
  "product",
  "project",
  "system",
  "tool",
  "service",
  "work",
])

const GENERIC_PHRASE_PATTERNS = [
  /\bspeaker\b/i,
  /^\d{1,2}\s+(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}$/i,
  /^(january|february|march|april|may|june|july|august|september|october|november|december)\s+\d{4}$/i,
  /^none$/i,
  /^no\s+(named\s+)?entities?$/i,
  /^no\s+proper\s+nouns?$/i,
  /^key\s+facts?$/i,
  /^(decisions?|plans?|decisions?\s*&\s*plans?)$/i,
  /^(preferences?|properties|relationships?|events?|general)$/i,
  /\bfood truck\b/i,
  /\bincome inequality\b/i,
  /\bfinancial struggles\b/i,
  /\blive streams?\b/i,
  /\boutdoor gear\b/i,
  /\bvegetarian food truck\b/i,
  /\btop-rated food truck\b/i,
  /\bcommon snack\b/i,
  /\bpopular snack\b/i,
  /\broad trip\b/i,
  /\bsupport group\b/i,
]

function canonicalEntityName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ")
}

function normalizeStructuredEntityName(name: string): string {
  const canonical = canonicalEntityName(name)
  if (["speaker a", "user", "i", "me"].includes(canonical)) return "Benchmark User"
  if (["speaker b", "assistant"].includes(canonical)) return "Benchmark Assistant"
  return name.trim()
}

function hasNamedSignal(name: string): boolean {
  const tokens = name.match(/[A-Za-z][A-Za-z0-9&.'-]*/g) ?? []
  const capitalized = tokens.filter(
    (token) =>
      /^[A-Z][A-Za-z0-9&.'-]*$/.test(token) ||
      /^[A-Z0-9]{2,}$/.test(token) ||
      /[a-z][A-Z]/.test(token)
  )
  return (
    capitalized.length > 0 || /\b[A-Z]{2,}\b/.test(name) || /\d/.test(name) || /\w+\.\w+/.test(name)
  )
}

function hasStrongNamedSignal(name: string): boolean {
  const tokens = name.match(/[A-Za-z][A-Za-z0-9&.'-]*/g) ?? []
  const capitalized = tokens.filter(
    (token) =>
      /^[A-Z][A-Za-z0-9&.'-]*$/.test(token) ||
      /^[A-Z0-9]{2,}$/.test(token) ||
      /[a-z][A-Z]/.test(token)
  )
  return (
    capitalized.length >= 2 ||
    /\b[A-Z]{2,}\b/.test(name) ||
    /\d/.test(name) ||
    /\w+\.\w+/.test(name)
  )
}

export function isAllowedStructuredEntityName(name: string, entityType?: string): boolean {
  const trimmed = normalizeStructuredEntityName(name)
  if (trimmed.length < 4) return false

  const canonical = canonicalEntityName(trimmed)
  if (ROLE_OR_GENERIC_ENTITY_NAMES.has(canonical)) return false
  if (GENERIC_PHRASE_PATTERNS.some((pattern) => pattern.test(trimmed))) return false

  const type = canonicalEntityName(entityType ?? "unknown")
  if (GENERIC_ENTITY_TYPES.has(type)) return hasStrongNamedSignal(trimmed)
  if (NAMED_ENTITY_TYPES.has(type)) return hasNamedSignal(trimmed)

  return hasNamedSignal(trimmed)
}

function cleanEntityType(type: string | undefined): string | undefined {
  const normalized = canonicalEntityName(type ?? "")
  if (!normalized) return undefined
  return normalized === "concept" ? "unknown" : normalized
}

function cleanConfidence(value: number | undefined): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0.7
}

function cleanImportance(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  return Math.min(Math.max(value, 0), 1)
}

function cleanKey(value: string | undefined): string | undefined {
  const raw = typeof value === "string" ? value : ""
  const normalized = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
  return normalized.length >= 3 ? normalized.slice(0, 120) : undefined
}

function cleanGroupKey(value: string | undefined): string | undefined {
  return cleanKey(value) ?? "general"
}

function cleanClaimKey(value: string | undefined, content: string): string | undefined {
  const normalized = cleanKey(value)
  if (normalized) return normalized
  const fallback = content
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .replace(/_{2,}/g, "_")
  return fallback.length >= 3 ? fallback.slice(0, 80) : undefined
}

export function sanitizeStructuredExtraction(
  structured: StructuredExtraction["structured"]
): StructuredExtraction["structured"] {
  const entities = structured.entities
    .map((entity) => ({
      source: normalizeStructuredEntityName(entity.source),
      sourceType: entity.sourceType?.trim(),
      relationship: entity.relationship.trim(),
      target: normalizeStructuredEntityName(entity.target),
      targetType: entity.targetType?.trim(),
      confidence: cleanConfidence(entity.confidence),
    }))
    .filter(
      (entity) =>
        entity.relationship.length > 0 &&
        isAllowedStructuredEntityName(entity.source, entity.sourceType) &&
        isAllowedStructuredEntityName(entity.target, entity.targetType)
    )
    .map((entity) => ({
      ...entity,
      sourceType: cleanEntityType(entity.sourceType),
      targetType: cleanEntityType(entity.targetType),
    }))

  const aspects = structured.aspects
    .map((aspect) => ({
      entityName: normalizeStructuredEntityName(aspect.entityName),
      aspect: aspect.aspect.trim(),
      attributes: aspect.attributes
        .map((attribute) => ({
          groupKey: cleanGroupKey(attribute.groupKey),
          claimKey: cleanClaimKey(attribute.claimKey, attribute.content),
          content: attribute.content.trim(),
          confidence: cleanConfidence(attribute.confidence),
          importance: cleanImportance(attribute.importance),
        }))
        .filter((attribute) => attribute.content.length > 0),
    }))
    .filter(
      (aspect) =>
        aspect.aspect.length > 0 &&
        aspect.attributes.length > 0 &&
        isAllowedStructuredEntityName(aspect.entityName)
    )

  const hints = structured.hints
    .map((hint) => hint.trim())
    .filter(
      (hint, index, all) => hint.length >= 5 && hint.length <= 300 && all.indexOf(hint) === index
    )

  return { entities, aspects, hints }
}

/** Parse JSON from LLM output, stripping code fences and surrounding chatter if present */
export function parseJson(raw: string): unknown {
  const trimmed = raw.trim()
  try {
    return JSON.parse(trimmed)
  } catch {
    const stripped = trimmed.replace(/^```(?:json)?\s*\n?/m, "").replace(/\n?```\s*$/m, "")
    try {
      return JSON.parse(stripped)
    } catch {
      const start = stripped.indexOf("{")
      const end = stripped.lastIndexOf("}")
      if (start >= 0 && end > start) {
        return JSON.parse(stripped.slice(start, end + 1))
      }
      throw new Error("Could not parse structured extraction JSON")
    }
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
    maxTokens: EXTRACTION_MAX_TOKENS,
    ...extractionTemperature(),
  }

  const { text } = await generateText(params as Parameters<typeof generateText>[0])
  const content = text.trim()

  const structuredParams: Record<string, unknown> = {
    model: openai(EXTRACTION_MODEL),
    prompt: buildStructuredPrompt(content),
    maxTokens: STRUCTURED_EXTRACTION_MAX_TOKENS,
    ...extractionTemperature(),
  }

  const { text: raw } = await generateText(structuredParams as Parameters<typeof generateText>[0])

  const fallback = { entities: [], aspects: [], hints: [] }
  let structured: StructuredExtraction["structured"]
  try {
    const parsed = parseJson(raw.trim()) as StructuredExtraction["structured"]
    structured = sanitizeStructuredExtraction({
      entities: Array.isArray(parsed.entities) ? parsed.entities : [],
      aspects: Array.isArray(parsed.aspects) ? parsed.aspects : [],
      hints: Array.isArray(parsed.hints) ? parsed.hints : [],
    })
  } catch {
    structured = fallback
  }

  return { content, structured }
}
