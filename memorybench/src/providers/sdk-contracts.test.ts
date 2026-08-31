import { describe, expect, test } from "bun:test"
import { collectMem0EventIds, createMem0SearchOptions } from "./mem0"
import { classifySupermemoryDocumentStatus } from "./supermemory"

describe("provider SDK contract regressions", () => {
  test("uses Mem0 v3 filters and camel-cased async event IDs", () => {
    expect(createMem0SearchOptions({ containerTag: "agent-1", limit: 7 })).toEqual({
      filters: { user_id: "agent-1" },
      topK: 7,
      enableGraph: false,
    })
    expect(collectMem0EventIds({ eventId: "event-1", status: "PENDING" })).toEqual(["event-1"])
    expect(collectMem0EventIds([{ eventId: "event-2" }, { event_id: "stale-shape" }])).toEqual([
      "event-2",
    ])
  })

  test("uses the Supermemory document workflow status as the indexing contract", () => {
    expect(classifySupermemoryDocumentStatus("done")).toBe("completed")
    expect(classifySupermemoryDocumentStatus("failed")).toBe("failed")
    expect(classifySupermemoryDocumentStatus("embedding")).toBe("pending")
  })
})
