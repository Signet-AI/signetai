import { embedMany, embed } from "ai"
import { createOpenAI } from "@ai-sdk/openai"
import type {
  Provider,
  ProviderConfig,
  IngestOptions,
  IngestResult,
  SearchOptions,
  IndexingProgressCallback,
} from "../../types/provider"
import type { UnifiedSession } from "../../types/unified"
import { createConfiguredOpenAI } from "../../utils/config"
import { logger } from "../../utils/logger"
import { HybridSearchEngine } from "./search"
import type { Chunk } from "./search"
import { RAG_PROMPTS } from "./prompts"
import { extractMemories } from "../../prompts/extraction"
const CHUNK_SIZE = 1600
const CHUNK_OVERLAP = 320
const EMBEDDING_BATCH_SIZE = 100
const EMBEDDING_MODEL = "text-embedding-3-small"
function chunkText(text: string, chunkSize: number = CHUNK_SIZE, overlap: number = CHUNK_OVERLAP): string[] {
  if (text.length <= chunkSize) {
    return [text.trim()]
  }

  const chunks: string[] = []
  let start = 0

  while (start < text.length) {
    let end = start + chunkSize

    if (end >= text.length) {
      chunks.push(text.slice(start).trim())
      break
    }
    let breakPoint = text.lastIndexOf(". ", end)
    if (breakPoint <= start || breakPoint < start + chunkSize * 0.5) {
      breakPoint = text.lastIndexOf("\n", end)
    }
    if (breakPoint <= start || breakPoint < start + chunkSize * 0.5) {
      breakPoint = text.lastIndexOf(" ", end)
    }
    if (breakPoint <= start) {
      breakPoint = end
    }

    chunks.push(text.slice(start, breakPoint + 1).trim())
    start = breakPoint + 1 - overlap

    if (start < 0) start = 0
  }

  return chunks.filter((c) => c.length > 0)
}
export class RAGProvider implements Provider {
  name = "rag"
  prompts = RAG_PROMPTS
  concurrency = {
    default: 20,
    ingest: 10,
    indexing: 50,
  }

  private searchEngine = new HybridSearchEngine()
  private openai: ReturnType<typeof createOpenAI> | null = null
  private apiKey: string = ""

  async initialize(config: ProviderConfig): Promise<void> {
    this.apiKey = config.apiKey
    if (!this.apiKey) {
      throw new Error("RAG provider requires OPENAI_API_KEY for memory extraction and embeddings")
    }
    this.openai = createConfiguredOpenAI(this.apiKey)
    logger.info("Initialized RAG memory provider (OpenClaw/QMD-style with LLM extraction + hybrid search)")
  }

  async ingest(sessions: UnifiedSession[], options: IngestOptions): Promise<IngestResult> {
    if (!this.openai) throw new Error("Provider not initialized")

    const allChunks: Array<{
      text: string
      sessionId: string
      chunkIndex: number
      date: string
      metadata?: Record<string, unknown>
    }> = []
    for (const session of sessions) {
      const extracted = await extractMemories(this.openai, session)
      const isoDate = (session.metadata?.date as string) || "unknown"
      const dateStr = isoDate !== "unknown" ? isoDate.split("T")[0] : "unknown"
      const dateHeader = `# Memories from ${dateStr}\n\n`
      const content = dateHeader + extracted

      const textChunks = chunkText(content)

      for (let i = 0; i < textChunks.length; i++) {
        allChunks.push({
          text: textChunks[i],
          sessionId: session.sessionId,
          chunkIndex: i,
          date: dateStr,
          metadata: {
            ...session.metadata,
            memoryDate: dateStr,
          },
        })
      }
    }

    if (allChunks.length === 0) {
      return { documentIds: [] }
    }
    const embeddedChunks: Chunk[] = []
    const embeddingModel = this.openai.embedding(EMBEDDING_MODEL)

    for (let i = 0; i < allChunks.length; i += EMBEDDING_BATCH_SIZE) {
      const batch = allChunks.slice(i, i + EMBEDDING_BATCH_SIZE)
      const texts = batch.map((c) => c.text)

      const { embeddings } = await embedMany({
        model: embeddingModel,
        values: texts,
      })

      for (let j = 0; j < batch.length; j++) {
        const chunk = batch[j]
        const id = `${options.containerTag}_${chunk.sessionId}_${chunk.chunkIndex}`
        embeddedChunks.push({
          id,
          content: chunk.text,
          sessionId: chunk.sessionId,
          chunkIndex: chunk.chunkIndex,
          embedding: embeddings[j],
          date: chunk.date,
          metadata: chunk.metadata,
        })
      }

      logger.debug(
        `Embedded batch ${Math.floor(i / EMBEDDING_BATCH_SIZE) + 1}/${Math.ceil(allChunks.length / EMBEDDING_BATCH_SIZE)} (${batch.length} chunks)`
      )
    }
    this.searchEngine.addChunks(options.containerTag, embeddedChunks)

    const documentIds = embeddedChunks.map((c) => c.id)
    logger.debug(
      `Ingested ${sessions.length} session(s) as ${embeddedChunks.length} extracted memory chunks for ${options.containerTag}`
    )

    return { documentIds }
  }

  async awaitIndexing(
    result: IngestResult,
    _containerTag: string,
    onProgress?: IndexingProgressCallback
  ): Promise<void> {
    onProgress?.({
      completedIds: result.documentIds,
      failedIds: [],
      total: result.documentIds.length,
    })
  }

  async search(query: string, options: SearchOptions): Promise<unknown[]> {
    if (!this.openai) throw new Error("Provider not initialized")
    const embeddingModel = this.openai.embedding(EMBEDDING_MODEL)
    const { embedding: queryEmbedding } = await embed({
      model: embeddingModel,
      value: query,
    })

    const limit = options.limit || 10
    const results = this.searchEngine.search(options.containerTag, queryEmbedding, query, limit)

    logger.debug(
      `Search returned ${results.length} results for "${query.substring(0, 50)}..." ` +
        `(${this.searchEngine.getChunkCount(options.containerTag)} total chunks)`
    )

    return results
  }

  async clear(containerTag: string): Promise<void> {
    this.searchEngine.clear(containerTag)
    logger.info(`Cleared RAG data for: ${containerTag}`)
  }
}

export default RAGProvider
