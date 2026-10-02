import type { QuestionFilter } from "../types/benchmark"
import type { UnifiedQuestion } from "../types/unified"

export function filterBenchmarkQuestions(
  questions: readonly UnifiedQuestion[],
  filter?: QuestionFilter
): UnifiedQuestion[] {
  const questionTypes = filter?.questionTypes
  let result = questionTypes?.length
    ? questions.filter((question) => questionTypes.includes(question.questionType))
    : [...questions]

  if (filter?.offset) result = result.slice(filter.offset)
  if (filter?.limit) result = result.slice(0, filter.limit)

  return result
}
