import type { JudgeInput, JudgeResult } from "../types/judge"
import type { ProviderPrompts } from "../types/prompts"
import { getJudgePromptForType } from "../prompts/defaults"

export function getJudgePrompt(questionType: string, _providerPrompts?: ProviderPrompts): string {
  return getJudgePromptForType(questionType)
}

export function buildJudgePrompt(input: JudgeInput): string {
  if (input.providerPrompts?.judgePrompt) {
    const prompts = input.providerPrompts.judgePrompt(
      input.question,
      input.groundTruth,
      input.hypothesis
    )
    return prompts[input.questionType] ?? prompts.default
  }

  const systemPrompt = getJudgePromptForType(input.questionType)
  const isPreference = input.questionType.toLowerCase().includes("preference")
  const groundTruthLabel = isPreference ? "Rubric" : "Ground Truth Answer"

  return `${systemPrompt}

Question: ${input.question}
${groundTruthLabel}: ${input.groundTruth}
System's Hypothesis: ${input.hypothesis}`
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

export function parseJudgeResponse(response: string): JudgeResult {
  const jsonMatch = response.match(/\{[\s\S]*\}/)
  if (!jsonMatch) {
    throw new Error("Judge response did not include a JSON object")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(jsonMatch[0])
  } catch {
    throw new Error("Judge response contained invalid JSON")
  }

  if (!isRecord(parsed)) {
    throw new Error("Judge response JSON must be an object")
  }
  if (parsed.score !== 0 && parsed.score !== 1) {
    throw new Error("Judge response score must be 0 or 1")
  }
  if (parsed.label !== "correct" && parsed.label !== "incorrect") {
    throw new Error("Judge response label must be correct or incorrect")
  }
  if ((parsed.score === 1) !== (parsed.label === "correct")) {
    throw new Error("Judge response score and label disagree")
  }
  if (parsed.explanation !== undefined && typeof parsed.explanation !== "string") {
    throw new Error("Judge response explanation must be a string")
  }

  return {
    score: parsed.score,
    label: parsed.label,
    explanation: parsed.explanation ?? "",
  }
}
