import { existsSync, readFileSync } from "node:fs"
import { dirname, isAbsolute, join } from "node:path"
import { fileURLToPath } from "node:url"
import type { Benchmark, BenchmarkConfig, QuestionFilter } from "../../types/benchmark"
import type { QuestionTypeRegistry, UnifiedMessage, UnifiedQuestion, UnifiedSession } from "../../types/unified"

const DEFAULT_DATA_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  "../../../config/dreaming-gate/scenarios.json"
)

interface ScenarioMessage {
  role: UnifiedMessage["role"]
  content: string
}

interface ScenarioSession {
  id: string
  agentId?: string
  date: string
  messages: ScenarioMessage[]
}

interface ScenarioExpected {
  relevantSessionIds: string[]
  sourceQuotes: string[]
  requiresExactSourceRefs: boolean
}

interface DreamingScenario {
  id: string
  agentId: string
  question: string
  groundTruth: string
  sessions: ScenarioSession[]
  expected: ScenarioExpected
}

interface DreamingScenarioCorpus {
  schemaVersion: number
  name: string
  scenarios: DreamingScenario[]
}

export const DREAMING_SCENARIO_QUESTION_TYPES: QuestionTypeRegistry = {
  "dreaming-contract": {
    id: "dreaming-contract",
    alias: "dreaming",
    description: "Synthetic, source-backed Dreaming contract scenarios",
  },
}

function assertNonEmptyString(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || value.trim() === "") throw new Error(`Dreaming scenario ${label} must be a non-empty string`)
}

function assertAgentId(value: unknown, label: string): asserts value is string {
  assertNonEmptyString(value, label)
  if (!/^[A-Za-z0-9._:-]+$/.test(value)) {
    throw new Error(`Dreaming scenario ${label} must only contain letters, numbers, dot, underscore, colon, or hyphen`)
  }
}

function assertStringArray(value: unknown, label: string): asserts value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.some((item) => typeof item !== "string" || item.trim() === "")) {
    throw new Error(`Dreaming scenario ${label} must be a non-empty string array`)
  }
}

export function parseDreamingScenarioCorpus(value: unknown): DreamingScenarioCorpus {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Dreaming scenario corpus must be an object")
  const corpus = value as Partial<DreamingScenarioCorpus>
  if (corpus.schemaVersion !== 1) throw new Error(`Unsupported Dreaming scenario schema version: ${String(corpus.schemaVersion)}`)
  assertNonEmptyString(corpus.name, "corpus name")
  if (!Array.isArray(corpus.scenarios) || corpus.scenarios.length === 0) {
    throw new Error("Dreaming scenario corpus must contain at least one scenario")
  }

  const ids = new Set<string>()
  for (const scenario of corpus.scenarios) {
    if (!scenario || typeof scenario !== "object") throw new Error("Dreaming scenario must be an object")
    assertAgentId(scenario.id, "id")
    if (ids.has(scenario.id)) throw new Error(`Duplicate Dreaming scenario id: ${scenario.id}`)
    ids.add(scenario.id)
    assertAgentId(scenario.agentId, `${scenario.id}.agentId`)
    assertNonEmptyString(scenario.question, `${scenario.id}.question`)
    assertNonEmptyString(scenario.groundTruth, `${scenario.id}.groundTruth`)
    if (!Array.isArray(scenario.sessions) || scenario.sessions.length === 0) {
      throw new Error(`Dreaming scenario ${scenario.id} must contain at least one session`)
    }
    if (!scenario.expected || typeof scenario.expected !== "object") {
      throw new Error(`Dreaming scenario ${scenario.id} must define expected evidence`)
    }
    assertStringArray(scenario.expected.relevantSessionIds, `${scenario.id}.expected.relevantSessionIds`)
    assertStringArray(scenario.expected.sourceQuotes, `${scenario.id}.expected.sourceQuotes`)
    if (scenario.expected.requiresExactSourceRefs !== true) {
      throw new Error(`Dreaming scenario ${scenario.id} must require exact source references`)
    }

    const sessionIds = new Set<string>()
    const sessionText: string[] = []
    for (const session of scenario.sessions) {
      assertAgentId(session.id, `${scenario.id}.session.id`)
      if (sessionIds.has(session.id)) throw new Error(`Dreaming scenario ${scenario.id} has duplicate session id: ${session.id}`)
      sessionIds.add(session.id)
      if (session.agentId !== undefined) assertAgentId(session.agentId, `${scenario.id}.${session.id}.agentId`)
      assertNonEmptyString(session.date, `${scenario.id}.${session.id}.date`)
      if (Number.isNaN(Date.parse(session.date))) throw new Error(`Dreaming scenario ${scenario.id}.${session.id}.date must be ISO-parseable`)
      if (!Array.isArray(session.messages) || session.messages.length === 0) {
        throw new Error(`Dreaming scenario ${scenario.id}.${session.id} must contain messages`)
      }
      for (const message of session.messages) {
        if (message.role !== "user" && message.role !== "assistant") {
          throw new Error(`Dreaming scenario ${scenario.id}.${session.id} has invalid message role`)
        }
        assertNonEmptyString(message.content, `${scenario.id}.${session.id}.message.content`)
        sessionText.push(message.content)
      }
    }

    for (const sessionId of scenario.expected.relevantSessionIds) {
      if (!sessionIds.has(sessionId)) {
        throw new Error(`Dreaming scenario ${scenario.id} expects unknown relevant session: ${sessionId}`)
      }
    }
    for (const quote of scenario.expected.sourceQuotes) {
      if (!sessionText.some((content) => content.includes(quote))) {
        throw new Error(`Dreaming scenario ${scenario.id} source quote is not present in a fixture session: ${quote}`)
      }
    }
  }

  return corpus as DreamingScenarioCorpus
}

export class DreamingScenariosBenchmark implements Benchmark {
  name = "dreaming-scenarios"
  private questions: UnifiedQuestion[] = []
  private sessionsByQuestion = new Map<string, UnifiedSession[]>()

  async load(config?: BenchmarkConfig): Promise<void> {
    const dataPath = config?.dataPath ?? DEFAULT_DATA_PATH
    const path = isAbsolute(dataPath) ? dataPath : join(process.cwd(), dataPath)
    if (!existsSync(path)) throw new Error(`Dreaming scenario corpus is missing: ${path}`)
    const corpus = parseDreamingScenarioCorpus(JSON.parse(readFileSync(path, "utf8")) as unknown)

    this.questions = corpus.scenarios.map((scenario) => ({
      questionId: scenario.id,
      question: scenario.question,
      questionType: "dreaming-contract",
      groundTruth: scenario.groundTruth,
      haystackSessionIds: scenario.sessions.map((session) => session.id),
      relevantSessionIds: scenario.expected.relevantSessionIds,
      metadata: {
        agentId: scenario.agentId,
        sourceQuotes: scenario.expected.sourceQuotes,
        requiresExactSourceRefs: scenario.expected.requiresExactSourceRefs,
      },
    }))
    this.sessionsByQuestion = new Map(
      corpus.scenarios.map((scenario) => [
        scenario.id,
        scenario.sessions.map((session) => ({
          sessionId: session.id,
          messages: session.messages,
          metadata: {
            date: session.date,
            agentId: session.agentId ?? scenario.agentId,
          },
        })),
      ])
    )
  }

  getQuestions(filter?: QuestionFilter): UnifiedQuestion[] {
    let questions = [...this.questions]
    if (filter?.questionTypes?.length) questions = questions.filter((question) => filter.questionTypes?.includes(question.questionType))
    if (filter?.offset) questions = questions.slice(filter.offset)
    if (filter?.limit) questions = questions.slice(0, filter.limit)
    return questions
  }

  getHaystackSessions(questionId: string): UnifiedSession[] {
    return this.sessionsByQuestion.get(questionId) ?? []
  }

  getGroundTruth(questionId: string): string {
    return this.questions.find((question) => question.questionId === questionId)?.groundTruth ?? ""
  }

  getQuestionTypes(): QuestionTypeRegistry {
    return DREAMING_SCENARIO_QUESTION_TYPES
  }
}

export default DreamingScenariosBenchmark
