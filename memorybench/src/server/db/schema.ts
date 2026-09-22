import { sqliteTable, text, integer, real, uniqueIndex } from "drizzle-orm/sqlite-core"

export const leaderboardEntries = sqliteTable(
  "leaderboard_entries",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    runId: text("run_id").notNull(),
    provider: text("provider").notNull(),
    benchmark: text("benchmark").notNull(),
    version: text("version").notNull().default("baseline"),
    accuracy: real("accuracy").notNull(),
    totalQuestions: integer("total_questions").notNull(),
    correctCount: integer("correct_count").notNull(),
    byQuestionType: text("by_question_type").notNull(),
    latencyStats: text("latency_stats"),
    evaluations: text("evaluations"),
    providerCode: text("provider_code").notNull(),
    promptsUsed: text("prompts_used"),
    judgeModel: text("judge_model").notNull(),
    answeringModel: text("answering_model").notNull(),
    addedAt: text("added_at").notNull(),
    notes: text("notes"),
  },
  (table) => ({
    providerBenchmarkVersion: uniqueIndex("provider_benchmark_version_idx").on(
      table.provider,
      table.benchmark,
      table.version
    ),
  })
)

export type LeaderboardEntry = typeof leaderboardEntries.$inferSelect
export type NewLeaderboardEntry = typeof leaderboardEntries.$inferInsert
