import { eq, desc, and } from "drizzle-orm"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { db, schema } from "../db"
import { CheckpointManager } from "../../orchestrator/checkpoint"
import { createBenchmark } from "../../benchmarks"
import type { BenchmarkName } from "../../types/benchmark"

const checkpointManager = new CheckpointManager()

const benchmarkRegistryCache: Record<string, any> = {}

function getQuestionTypeRegistry(benchmarkName: string) {
  if (!benchmarkRegistryCache[benchmarkName]) {
    const benchmark = createBenchmark(benchmarkName as BenchmarkName)
    benchmarkRegistryCache[benchmarkName] = benchmark.getQuestionTypes()
  }
  return benchmarkRegistryCache[benchmarkName]
}

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

export async function handleLeaderboardRoutes(req: Request, url: URL): Promise<Response | null> {
  const method = req.method
  const pathname = url.pathname
  if (method === "GET" && pathname === "/api/leaderboard") {
    try {
      const entries = db
        .select()
        .from(schema.leaderboardEntries)
        .orderBy(desc(schema.leaderboardEntries.accuracy))
        .all()
      const parsed = entries.map((entry) => {
        let byQuestionType = {}
        let latencyStats = null
        let evaluations: unknown[] = []
        let promptsUsed = null

        try {
          byQuestionType = JSON.parse(entry.byQuestionType)
        } catch {
        }
        try {
          latencyStats = entry.latencyStats ? JSON.parse(entry.latencyStats) : null
        } catch {
        }
        try {
          evaluations = entry.evaluations ? JSON.parse(entry.evaluations) : []
        } catch {
        }
        try {
          promptsUsed = entry.promptsUsed ? JSON.parse(entry.promptsUsed) : null
        } catch {
        }

        return {
          ...entry,
          byQuestionType,
          questionTypeRegistry: getQuestionTypeRegistry(entry.benchmark),
          latencyStats,
          evaluations,
          promptsUsed,
        }
      })

      return json({ entries: parsed })
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Failed to load leaderboard" }, 500)
    }
  }
  if (method === "POST" && pathname === "/api/leaderboard") {
    try {
      const body = await req.json()
      const { runId, notes, version } = body

      if (!runId) {
        return json({ error: "runId is required" }, 400)
      }
      const entryVersion = version?.trim() || "baseline"
      const checkpoint = checkpointManager.load(runId)
      if (!checkpoint) {
        return json({ error: `Run not found: ${runId}` }, 404)
      }
      const summary = checkpointManager.getSummary(checkpoint)
      if (summary.evaluated !== summary.total) {
        return json({ error: "Run must be fully evaluated before adding to leaderboard" }, 400)
      }
      const existing = db
        .select()
        .from(schema.leaderboardEntries)
        .where(
          and(
            eq(schema.leaderboardEntries.provider, checkpoint.provider),
            eq(schema.leaderboardEntries.benchmark, checkpoint.benchmark),
            eq(schema.leaderboardEntries.version, entryVersion)
          )
        )
        .get()
      const reportPath = join(checkpointManager.getRunPath(runId), "report.json")
      let report: any = null
      if (existsSync(reportPath)) {
        report = JSON.parse(readFileSync(reportPath, "utf8"))
      }
      const questions = Object.values(checkpoint.questions)
      const correctCount = questions.filter((q: any) => q.phases?.evaluate?.score === 1).length
      const accuracy = report?.summary?.accuracy ?? correctCount / summary.total
      const providerCode = getProviderCode(checkpoint.provider)
      const promptsUsed = getProviderPrompts(checkpoint.provider)
      const byQuestionType: Record<string, { total: number; correct: number; accuracy: number }> =
        {}
      for (const q of questions) {
        const qData = q as any
        const type = qData.questionType || "unknown"
        if (!byQuestionType[type]) {
          byQuestionType[type] = { total: 0, correct: 0, accuracy: 0 }
        }
        byQuestionType[type].total++
        if (qData.phases?.evaluate?.score === 1) {
          byQuestionType[type].correct++
        }
      }
      for (const type of Object.keys(byQuestionType)) {
        byQuestionType[type].accuracy = byQuestionType[type].correct / byQuestionType[type].total
      }
      let evaluations = report?.evaluations || []
      if (!report?.evaluations) {
        evaluations = questions.map((q: any) => ({
          questionId: q.questionId,
          questionType: q.questionType,
          question: q.question,
          groundTruth: q.groundTruth,
          hypothesis: q.phases?.answer?.hypothesis || "",
          score: q.phases?.evaluate?.score || 0,
          label: q.phases?.evaluate?.label || "incorrect",
          explanation: q.phases?.evaluate?.explanation || "",
          searchResults: q.phases?.search?.results || [],
        }))
      }

      const entryData = {
        runId,
        provider: checkpoint.provider,
        benchmark: checkpoint.benchmark,
        version: entryVersion,
        accuracy,
        totalQuestions: summary.total,
        correctCount,
        byQuestionType: JSON.stringify(byQuestionType),
        latencyStats: report?.latency ? JSON.stringify(report.latency) : null,
        evaluations: JSON.stringify(evaluations),
        providerCode,
        promptsUsed: promptsUsed ? JSON.stringify(promptsUsed) : null,
        judgeModel: checkpoint.judge,
        answeringModel: checkpoint.answeringModel,
        addedAt: new Date().toISOString(),
        notes: notes || null,
      }

      let entry
      let isUpdate = false

      if (existing) {
        entry = db
          .update(schema.leaderboardEntries)
          .set(entryData)
          .where(eq(schema.leaderboardEntries.id, existing.id))
          .returning()
          .get()
        isUpdate = true
      } else {
        entry = db.insert(schema.leaderboardEntries).values(entryData).returning().get()
      }

      return json({
        message: isUpdate ? "Updated leaderboard entry" : "Added to leaderboard",
        entry: {
          ...entry,
          byQuestionType,
          latencyStats: report?.latency || null,
        },
      })
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Failed to add to leaderboard" }, 500)
    }
  }
  const deleteMatch = pathname.match(/^\/api\/leaderboard\/(\d+)$/)
  if (method === "DELETE" && deleteMatch) {
    try {
      const id = parseInt(deleteMatch[1])

      const entry = db
        .select()
        .from(schema.leaderboardEntries)
        .where(eq(schema.leaderboardEntries.id, id))
        .get()

      if (!entry) {
        return json({ error: "Entry not found" }, 404)
      }

      db.delete(schema.leaderboardEntries).where(eq(schema.leaderboardEntries.id, id)).run()

      return json({ message: "Removed from leaderboard", id })
    } catch (e) {
      return json(
        { error: e instanceof Error ? e.message : "Failed to remove from leaderboard" },
        500
      )
    }
  }
  const getMatch = pathname.match(/^\/api\/leaderboard\/(\d+)$/)
  if (method === "GET" && getMatch) {
    try {
      const id = parseInt(getMatch[1])

      const entry = db
        .select()
        .from(schema.leaderboardEntries)
        .where(eq(schema.leaderboardEntries.id, id))
        .get()

      if (!entry) {
        return json({ error: "Entry not found" }, 404)
      }

      let evaluations = []
      let promptsUsed = null
      let latencyStats = null
      let byQuestionType = {}

      try {
        byQuestionType = JSON.parse(entry.byQuestionType)
      } catch {
        byQuestionType = {}
      }

      try {
        latencyStats = entry.latencyStats ? JSON.parse(entry.latencyStats) : null
      } catch {
        latencyStats = null
      }

      try {
        evaluations = entry.evaluations ? JSON.parse(entry.evaluations) : []
      } catch {
        evaluations = []
      }

      try {
        promptsUsed = entry.promptsUsed ? JSON.parse(entry.promptsUsed) : null
      } catch {
        promptsUsed = null
      }

      return json({
        ...entry,
        byQuestionType,
        questionTypeRegistry: getQuestionTypeRegistry(entry.benchmark),
        latencyStats,
        evaluations,
        promptsUsed,
      })
    } catch (e) {
      return json({ error: e instanceof Error ? e.message : "Failed to get entry" }, 500)
    }
  }

  return null
}

function getProviderCode(provider: string): string {
  const providerDir = join(process.cwd(), "src", "providers", provider)
  const indexPath = join(providerDir, "index.ts")
  const promptPath = join(providerDir, "prompt.ts")
  const promptsPath = join(providerDir, "prompts.ts")

  const files: Record<string, string> = {}
  if (existsSync(indexPath)) {
    files["index.ts"] = readFileSync(indexPath, "utf8")
  }
  if (existsSync(promptPath)) {
    files["prompt.ts"] = readFileSync(promptPath, "utf8")
  }
  if (existsSync(promptsPath)) {
    files["prompts.ts"] = readFileSync(promptsPath, "utf8")
  }

  if (Object.keys(files).length === 0) {
    return `// Provider code not found at ${providerDir}`
  }
  return JSON.stringify(files)
}

function getProviderPrompts(provider: string): Record<string, string> | null {
  const providerDir = join(process.cwd(), "src", "providers", provider)
  const prompts: Record<string, string> = {}
  const promptFiles = ["prompt.ts", "prompts.ts"]
  for (const file of promptFiles) {
    const filePath = join(providerDir, file)
    if (existsSync(filePath)) {
      prompts[file] = readFileSync(filePath, "utf8")
    }
  }
  const indexPath = join(providerDir, "index.ts")
  if (existsSync(indexPath)) {
    const code = readFileSync(indexPath, "utf8")
    const promptMatches = code.matchAll(
      /(?:prompt|PROMPT|systemPrompt|userPrompt)\s*[=:]\s*[`"']([^`"']+)[`"']/g
    )
    for (const match of promptMatches) {
      const key = match[0].split(/[=:]/)[0].trim()
      prompts[`inline:${key}`] = match[1]
    }
  }

  return Object.keys(prompts).length > 0 ? prompts : null
}
