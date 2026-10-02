import type { SamplingConfig } from "../types/checkpoint"

type SamplingQuestion = { questionId: string; questionType: string }

export function selectQuestionsBySampling(
  allQuestions: readonly SamplingQuestion[],
  sampling: SamplingConfig
): string[] {
  if (sampling.mode === "full") {
    return allQuestions.map((question) => question.questionId)
  }
  if (sampling.mode === "limit" && sampling.limit) {
    return allQuestions.slice(0, sampling.limit).map((question) => question.questionId)
  }
  if (sampling.mode === "sample" && sampling.perCategory) {
    const byType: Record<string, SamplingQuestion[]> = {}
    for (const question of allQuestions) {
      if (!byType[question.questionType]) byType[question.questionType] = []
      byType[question.questionType].push(question)
    }
    const selected: string[] = []
    for (const questions of Object.values(byType)) {
      if (sampling.sampleType === "random") {
        const shuffled = [...questions].sort(() => Math.random() - 0.5)
        selected.push(
          ...shuffled.slice(0, sampling.perCategory).map((question) => question.questionId)
        )
      } else {
        selected.push(
          ...questions.slice(0, sampling.perCategory).map((question) => question.questionId)
        )
      }
    }
    return selected
  }
  return allQuestions.map((question) => question.questionId)
}
