import { DEFAULT_BEAM_DATA_PATH } from "../../benchmarks/beam"
import { prepareBeamDataset } from "../../benchmarks/beam/prepare"
import type { BeamScale } from "../../benchmarks/beam/types"

function parseTiers(value: string): BeamScale[] {
  const tiers = value.split(",").map((tier) => tier.trim())
  if (tiers.length === 0 || tiers.some((tier) => tier !== "1M" && tier !== "10M")) {
    throw new Error(`Invalid BEAM tiers ${value}; use 1M, 10M, or 1M,10M`)
  }
  return tiers as BeamScale[]
}

export async function beamCommand(args: string[]): Promise<void> {
  if (args[0] !== "prepare") {
    console.log(
      "Usage: bun run src/index.ts beam prepare [--tiers 1M|10M|1M,10M] [--data-path <dir>]"
    )
    return
  }

  let tiers: BeamScale[] = ["1M"]
  let outputRoot = DEFAULT_BEAM_DATA_PATH
  for (let index = 1; index < args.length; index++) {
    const argument = args[index]
    const value = args[++index]
    if (!value) throw new Error(`${argument} requires a value`)
    if (argument === "--tiers") {
      tiers = parseTiers(value)
    } else if (argument === "--data-path") {
      outputRoot = value
    } else {
      throw new Error(`Unknown beam prepare option: ${argument}`)
    }
  }

  const prepared = await prepareBeamDataset({ tiers, outputRoot })
  console.log(
    `${prepared.reused ? "Reused" : "Prepared"} BEAM ${tiers.join("/")} snapshot: ${prepared.snapshotPath}`
  )
  console.log(`Dataset fingerprint: ${prepared.manifest.datasetFingerprint}`)
  console.log(
    `Run with: -b beam-${tiers[0]!.toLowerCase()} --data-path ${outputRoot} --dataset-revision ${prepared.manifest.datasetFingerprint}`
  )
}
