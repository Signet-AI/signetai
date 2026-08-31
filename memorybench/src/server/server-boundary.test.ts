import { describe, expect, it } from "bun:test"
import { readFileSync } from "fs"
import { join } from "path"

const routeSource = (name: string): string =>
  readFileSync(join(import.meta.dir, "routes", `${name}.ts`), "utf8")

describe("MemoryBench server composition dependency invariant", () => {
  it("keeps route handlers independent of the server composition root", () => {
    expect(routeSource("runs")).not.toContain('from "../index"')
    expect(routeSource("compare")).not.toContain('from "../index"')
  })
})
