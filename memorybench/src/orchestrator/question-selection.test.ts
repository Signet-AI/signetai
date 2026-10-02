import { describe, expect, it, spyOn } from "bun:test"
import type { SamplingConfig } from "../types/checkpoint"
import { selectQuestionsBySampling } from "./question-selection"

const questions = [
  { questionId: "a1", questionType: "alpha" },
  { questionId: "b1", questionType: "beta" },
  { questionId: "a2", questionType: "alpha" },
  { questionId: "c1", questionType: "gamma" },
]

describe("selectQuestionsBySampling", () => {
  it("preserves source order for full and limited selections", () => {
    expect(selectQuestionsBySampling(questions, { mode: "full" })).toEqual(["a1", "b1", "a2", "c1"])
    expect(selectQuestionsBySampling(questions, { mode: "limit", limit: 2 })).toEqual(["a1", "b1"])
  })

  it("preserves the existing full-list fallback for zero limits", () => {
    expect(selectQuestionsBySampling(questions, { mode: "limit", limit: 0 })).toEqual([
      "a1",
      "b1",
      "a2",
      "c1",
    ])
    expect(selectQuestionsBySampling(questions, { mode: "sample", perCategory: 0 })).toEqual([
      "a1",
      "b1",
      "a2",
      "c1",
    ])
  })

  it("groups consecutive samples in first-seen category order", () => {
    const sampling: SamplingConfig = { mode: "sample", perCategory: 2 }
    expect(selectQuestionsBySampling(questions, sampling)).toEqual(["a1", "a2", "b1", "c1"])
  })

  it("uses randomness to choose one question from each category", () => {
    const random = spyOn(Math, "random")
    const sample = (randomValue: number) => {
      random.mockReturnValue(randomValue)
      return selectQuestionsBySampling(
        [
          ...questions,
          { questionId: "a3", questionType: "alpha" },
          { questionId: "b2", questionType: "beta" },
        ],
        { mode: "sample", sampleType: "random", perCategory: 1 }
      )
    }
    try {
      const first = sample(0)
      const second = sample(0.9)
      for (const selected of [first, second]) {
        expect(selected).toHaveLength(3)
        expect(selected.filter((questionId) => questionId.startsWith("a"))).toHaveLength(1)
        expect(selected.filter((questionId) => questionId.startsWith("b"))).toHaveLength(1)
        expect(selected.filter((questionId) => questionId.startsWith("c"))).toHaveLength(1)
      }
      expect(first).not.toEqual(second)
    } finally {
      random.mockRestore()
    }
  })
})
