import { describe, expect, it } from "bun:test"
import { normalizeGeneratedAnswer } from "./answer"

describe("normalizeGeneratedAnswer", () => {
  it("keeps non-empty model output", () => {
    expect(normalizeGeneratedAnswer("  The answer is 17.  ")).toBe("The answer is 17.")
  })

  it("turns empty model output into an explicit abstention", () => {
    expect(normalizeGeneratedAnswer(" \n\t ")).toBe("I don't know.")
  })
})
