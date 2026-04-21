import type { ProviderName } from "../../types/provider"
import type { BenchmarkName } from "../../types/benchmark"
import type { ConcurrencyConfig } from "../../types/concurrency"
import type { SamplingConfig, SampleType } from "../../types/checkpoint"
import { orchestrator, CheckpointManager } from "../../orchestrator"
import { getAvailableProviders } from "../../providers"
import { getAvailableBenchmarks } from "../../benchmarks"
import { logger } from "../../utils/logger"
import { appendCsvValues, parseCommaSeparated, readIdListFile } from "../args"

interface IngestArgs {
  provider?: string
  benchmark?: string
  runId: string
  limit?: number
  questionIds?: string[]
  questionTypes?: string[]
  sample?: number
  sampleType?: SampleType
  concurrency?: ConcurrencyConfig
  force?: boolean
}

function generateRunId(): string {
  const now = new Date()
  const date = now.toISOString().slice(0, 10).replace(/-/g, "")
  const time = now.toISOString().slice(11, 19).replace(/:/g, "")
  return `run-${date}-${time}`
}

export function parseIngestArgs(args: string[]): IngestArgs | null {
  const parsed: Partial<IngestArgs> = {}
  const concurrency: Partial<ConcurrencyConfig> = {}

  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg === "-p" || arg === "--provider") {
      parsed.provider = args[++i]
    } else if (arg === "-b" || arg === "--benchmark") {
      parsed.benchmark = args[++i]
    } else if (arg === "-r" || arg === "--run-id") {
      parsed.runId = args[++i]
    } else if (arg === "-l" || arg === "--limit") {
      parsed.limit = parseInt(args[++i], 10)
    } else if (arg === "-q" || arg === "--question-id") {
      const next = args[++i]
      if (!next) {
        logger.error(`${arg} requires a question id`)
        return null
      }
      const questionIds = appendCsvValues(parsed.questionIds, next)
      if (questionIds.length === (parsed.questionIds || []).length) {
        logger.error("Question id filter cannot be empty")
        return null
      }
      parsed.questionIds = questionIds
    } else if (arg === "--question-ids-file") {
      const next = args[++i]
      if (!next) {
        logger.error("--question-ids-file requires a path")
        return null
      }
      const questionIds = [...(parsed.questionIds || []), ...readIdListFile(next)]
      if (questionIds.length === (parsed.questionIds || []).length) {
        logger.error("Question ids file cannot be empty")
        return null
      }
      parsed.questionIds = questionIds
    } else if (arg === "-t" || arg === "--type" || arg === "--types") {
      const questionTypes = parseCommaSeparated(args[++i])
      if (questionTypes.length === 0) {
        logger.error("Question type filter cannot be empty")
        return null
      }
      parsed.questionTypes = [...(parsed.questionTypes || []), ...questionTypes]
    } else if (arg === "-s" || arg === "--sample") {
      parsed.sample = parseInt(args[++i], 10)
    } else if (arg === "--sample-type") {
      const type = args[++i] as SampleType
      if (type === "consecutive" || type === "random") {
        parsed.sampleType = type
      } else {
        logger.error(`Invalid sample type: ${type}. Valid types: consecutive, random`)
        return null
      }
    } else if (arg === "--concurrency") {
      concurrency.default = parseInt(args[++i], 10)
    } else if (arg === "--concurrency-ingest") {
      concurrency.ingest = parseInt(args[++i], 10)
    } else if (arg === "--concurrency-indexing") {
      concurrency.indexing = parseInt(args[++i], 10)
    } else if (arg === "--force") {
      parsed.force = true
    }
  }

  // Either runId alone (for continuation) or provider+benchmark (for new run)
  if (!parsed.runId && (!parsed.provider || !parsed.benchmark)) {
    return null
  }

  if (!parsed.runId) {
    parsed.runId = generateRunId()
  }

  if (Object.keys(concurrency).length > 0) {
    parsed.concurrency = concurrency as ConcurrencyConfig
  }

  return parsed as IngestArgs
}

export async function ingestCommand(args: string[]): Promise<void> {
  const parsed = parseIngestArgs(args)

  if (!parsed) {
    console.log("Usage:")
    console.log(
      "  New run:      bun run src/index.ts ingest -p <provider> -b <benchmark> [-r <runId>] [--force]"
    )
    console.log("  Continue run: bun run src/index.ts ingest -r <runId>")
    console.log("")
    console.log("Options:")
    console.log(`  -p, --provider   Provider: ${getAvailableProviders().join(", ")}`)
    console.log(`  -b, --benchmark  Benchmark: ${getAvailableBenchmarks().join(", ")}`)
    console.log("  -r, --run-id     Run identifier")
    console.log("  -q, --question-id Filter question id (repeat or comma-separate)")
    console.log("  --question-ids-file Read question ids from a newline-delimited file")
    console.log("  -t, --type       Filter question type (repeat or comma-separate)")
    console.log("  -s, --sample     Sample N questions per category")
    console.log("  -l, --limit      Limit total number of questions to ingest")
    console.log("  --concurrency N          Default concurrency for ingest/indexing")
    console.log("  --concurrency-ingest N   Concurrency for ingest phase")
    console.log("  --concurrency-indexing N Concurrency for indexing phase")
    console.log("  --force          Clear existing checkpoint and start fresh")
    return
  }

  const checkpointManager = new CheckpointManager()

  if (checkpointManager.exists(parsed.runId)) {
    const checkpoint = checkpointManager.load(parsed.runId)!

    if (parsed.provider && parsed.provider !== checkpoint.provider) {
      logger.error(
        `Run ${parsed.runId} exists with provider ${checkpoint.provider}, not ${parsed.provider}`
      )
      return
    }
    if (parsed.benchmark && parsed.benchmark !== checkpoint.benchmark) {
      logger.error(
        `Run ${parsed.runId} exists with benchmark ${checkpoint.benchmark}, not ${parsed.benchmark}`
      )
      return
    }

    parsed.provider = checkpoint.provider
    parsed.benchmark = checkpoint.benchmark
    logger.info(
      `Continuing ingest for ${parsed.runId} (${checkpoint.provider}/${checkpoint.benchmark})`
    )
  } else {
    if (!parsed.provider || !parsed.benchmark) {
      logger.error("New run requires -p/--provider and -b/--benchmark")
      return
    }

    if (!getAvailableProviders().includes(parsed.provider as ProviderName)) {
      console.error(`Invalid provider: ${parsed.provider}`)
      return
    }

    if (!getAvailableBenchmarks().includes(parsed.benchmark as BenchmarkName)) {
      console.error(`Invalid benchmark: ${parsed.benchmark}`)
      return
    }
  }

  let sampling: SamplingConfig | undefined
  if (parsed.sample) {
    sampling = {
      mode: "sample",
      sampleType: parsed.sampleType || "consecutive",
      perCategory: parsed.sample,
    }
  } else if (parsed.limit) {
    sampling = {
      mode: "limit",
      limit: parsed.limit,
    }
  }

  await orchestrator.ingest({
    provider: parsed.provider as ProviderName,
    benchmark: parsed.benchmark as BenchmarkName,
    runId: parsed.runId,
    questionIds: parsed.questionIds,
    questionTypes: parsed.questionTypes,
    sampling,
    concurrency: parsed.concurrency,
    force: parsed.force,
  })
}
