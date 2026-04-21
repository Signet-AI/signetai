import { describe, expect, test } from "bun:test"
import { mergeResumeConcurrency } from "./index"

describe("resume option handling", () => {
  test("keeps existing phase concurrency when no resume override is provided", () => {
    expect(mergeResumeConcurrency({ ingest: 3 }, undefined)).toEqual({ ingest: 3 })
  })

  test("merges phase-specific concurrency overrides on resumed runs", () => {
    expect(mergeResumeConcurrency({ ingest: 3 }, { answer: 1, evaluate: 1 })).toEqual({
      ingest: 3,
      answer: 1,
      evaluate: 1,
    })
  })

  test("allows resumed runs to replace an existing phase override", () => {
    expect(mergeResumeConcurrency({ default: 10, answer: 10 }, { answer: 1 })).toEqual({
      default: 10,
      answer: 1,
    })
  })
})
