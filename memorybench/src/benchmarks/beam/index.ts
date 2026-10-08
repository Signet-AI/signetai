import type { Benchmark, BenchmarkConfig, QuestionFilter } from "../../types/benchmark"
import type {
  QuestionTypeRegistry,
  UnifiedMessage,
  UnifiedQuestion,
  UnifiedSession,
} from "../../types/unified"
import { logger } from "../../utils/logger"
import {
  describeBeamSnapshot,
  describeBeamTemporalCoverage,
  loadPreparedBeamDataset,
  resolvePreparedSnapshotPath,
} from "./dataset"
import { BeamProtocol } from "./protocol"
import type {
  BeamCanonicalChat,
  BeamCanonicalQuestion,
  BeamDatasetManifest,
  BeamScale,
} from "./types"

export const DEFAULT_BEAM_DATA_PATH = "./data/benchmarks/beam"

export const BEAM_QUESTION_TYPES: QuestionTypeRegistry = {
  abstention: {
    id: "abstention",
    alias: "abstain",
    description: "Withhold answers when evidence is missing",
  },
  contradiction_resolution: {
    id: "contradiction_resolution",
    alias: "contradict",
    description: "Detect and reconcile inconsistent statements",
  },
  event_ordering: {
    id: "event_ordering",
    alias: "order",
    description: "Reconstruct event or information order",
  },
  information_extraction: {
    id: "information_extraction",
    alias: "extract",
    description: "Recall entities and factual details",
  },
  instruction_following: {
    id: "instruction_following",
    alias: "instruction",
    description: "Follow sustained user instructions",
  },
  knowledge_update: {
    id: "knowledge_update",
    alias: "update",
    description: "Retain updated facts over stale facts",
  },
  multi_session_reasoning: {
    id: "multi_session_reasoning",
    alias: "multi",
    description: "Reason across non-adjacent dialogue segments",
  },
  preference_following: {
    id: "preference_following",
    alias: "preference",
    description: "Adapt to evolving user preferences",
  },
  summarization: {
    id: "summarization",
    alias: "summary",
    description: "Summarize dialogue content",
  },
  temporal_reasoning: {
    id: "temporal_reasoning",
    alias: "temporal",
    description: "Reason about explicit and implicit time relations",
  },
}

function createSessions(chat: BeamCanonicalChat): UnifiedSession[] {
  return chat.sessions.map((session) => ({
    sessionId: session.sessionId,
    messages: session.messages.map(
      (message): UnifiedMessage => ({
        role: message.role,
        content: message.content,
        speaker: message.role,
        timestamp: message.timeAnchor,
      })
    ),
    metadata: {
      scale: chat.scale,
      chatId: chat.chatId,
      ...(session.planNumber ? { planNumber: session.planNumber } : {}),
      batchNumber: session.batchNumber,
      turnIndex: session.turnIndex,
      ...(session.documentDate
        ? { date: session.documentDate, documentDate: session.documentDate }
        : {}),
      ...(session.hadInvalidTimeAnchor ? { hadInvalidTimeAnchor: true } : {}),
      ...(session.hasPaddedAssistant ? { hasPaddedAssistant: true } : {}),
    },
  }))
}

function groundTruth(question: BeamCanonicalQuestion): string {
  return question.referenceAnswer || question.rubric.join("\n")
}

function datasetIdentity(manifest: BeamDatasetManifest, scale: BeamScale): Record<string, unknown> {
  const source = manifest.sources.find((entry) => entry.tier === scale)
  return {
    snapshotFingerprint: manifest.datasetFingerprint,
    manifestHash: manifest.manifestHash,
    converter: manifest.converter,
    tier: scale,
    counts: manifest.counts[scale],
    orderedQuestionIdsDigest: manifest.orderedQuestionIdsDigest[scale],
    source: source
      ? {
          repository: source.repository,
          revision: source.revision,
          sourceIdentity: source.sourceIdentity,
          files: source.files.map((file) => ({ path: file.path, sha256: file.sha256 })),
        }
      : undefined,
  }
}

export class BeamBenchmark implements Benchmark {
  readonly name: string
  protocol: BeamProtocol
  private readonly scale: BeamScale
  private questions: UnifiedQuestion[] = []
  private questionsById = new Map<string, UnifiedQuestion>()
  private sessionsByChat = new Map<string, UnifiedSession[]>()
  private identity?: Record<string, unknown>

  constructor(scale: BeamScale, name: string) {
    this.scale = scale
    this.name = name
    this.protocol = new BeamProtocol()
  }

  async load(config: BenchmarkConfig = {}): Promise<void> {
    this.protocol = new BeamProtocol({
      profile: config.evaluationProfile,
      retrievalTopK: config.retrievalTopK,
    })
    const snapshotPath = resolvePreparedSnapshotPath(
      config.dataPath || DEFAULT_BEAM_DATA_PATH,
      config.datasetRevision
    )
    const prepared = await loadPreparedBeamDataset({
      snapshotPath,
      tiers: [this.scale],
      expectedDatasetFingerprint: config.datasetRevision,
    })
    const chats = prepared.chatsByTier[this.scale]
    const questions = prepared.questionsByTier[this.scale]
    if (!chats || !questions) throw new Error(`Prepared BEAM snapshot is missing ${this.scale}`)

    this.identity = datasetIdentity(prepared.manifest, this.scale)
    this.sessionsByChat = new Map(chats.map((chat) => [chat.chatId, createSessions(chat)]))
    this.questions = questions.map((source) => {
      const sessions = this.sessionsByChat.get(source.chatId)
      if (!sessions) {
        throw new Error(
          `BEAM question ${source.questionId} references missing chat ${source.chatId}`
        )
      }
      return {
        questionId: source.questionId,
        question: source.question,
        questionType: source.questionType,
        groundTruth: groundTruth(source),
        haystackSessionIds: sessions.map((session) => session.sessionId),
        metadata: {
          scale: this.scale,
          chatId: source.chatId,
          rubric: source.rubric,
          difficulty: source.difficulty,
          referenceAnswer: source.referenceAnswer,
        },
      }
    })

    this.questionsById = new Map(this.questions.map((question) => [question.questionId, question]))

    logger.info(describeBeamTemporalCoverage(prepared.manifest.counts, [this.scale]))
    logger.info(
      `Loaded ${this.questions.length} BEAM questions from ${describeBeamSnapshot(prepared.manifest)} (profile=${this.protocol.profile}, top-k=${this.protocol.retrievalTopK})`
    )
  }

  getQuestions(filter?: QuestionFilter): UnifiedQuestion[] {
    let questions = [...this.questions]
    if (filter?.questionTypes?.length) {
      questions = questions.filter((question) =>
        filter.questionTypes!.includes(question.questionType)
      )
    }
    if (filter?.offset != null) questions = questions.slice(filter.offset)
    if (filter?.limit != null) questions = questions.slice(0, filter.limit)
    return questions
  }

  getHaystackSessions(questionId: string): UnifiedSession[] {
    const chatId = this.chatIdFor(questionId)
    return this.sessionsByChat.get(chatId) ?? []
  }

  getGroundTruth(questionId: string): string {
    const question = this.questionsById.get(questionId)
    if (!question) throw new Error(`Unknown BEAM question: ${questionId}`)
    return question.groundTruth
  }

  getQuestionTypes(): QuestionTypeRegistry {
    return BEAM_QUESTION_TYPES
  }

  getIngestionGroupId(questionId: string): string {
    return `beam-${this.scale}-${this.chatIdFor(questionId)}`
  }

  getDatasetIdentity(): Record<string, unknown> | undefined {
    return this.identity
  }

  private chatIdFor(questionId: string): string {
    const chatId = this.questionsById.get(questionId)?.metadata?.chatId
    if (typeof chatId !== "string") throw new Error(`Unknown BEAM question: ${questionId}`)
    return chatId
  }
}

export class Beam1MBenchmark extends BeamBenchmark {
  constructor() {
    super("1M", "beam-1m")
  }
}

export class Beam10MBenchmark extends BeamBenchmark {
  constructor() {
    super("10M", "beam-10m")
  }
}
