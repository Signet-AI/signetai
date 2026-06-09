import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";

/*
 * Budget ledger for the two root-level policy documents.
 *
 * These files describe what Signet is and how it is built. They age
 * badly when treated as append-only logs. The hard caps below make
 * growth expensive: a PR that adds to one of them has to delete
 * something else to land. The soft warn band is a budget indicator,
 * not a gate: it tells the author and reviewer that the file is
 * using 75%+ of its budget and a paired tighten belongs in the
 * same change.
 *
 * Budget tiers (in bytes):
 *   - 0 .. soft     : healthy
 *   - soft .. cap   : warn in test output, pass; reviewer should
 *                     ask "is this growth earned, or are we
 *                     accumulating?"
 *   - > cap         : hard fail. PR must delete to land.
 *
 * The cliff (cap exactly) is intentional. The ledger is not a
 * target to fill. Last reviewed and reset: 2026-06-09.
 */

const ROOT = join(import.meta.dir, "..");

interface Limit {
	readonly path: string;
	readonly capBytes: number;
	readonly softBytes: number;
	readonly label: string;
}

const LIMITS: ReadonlyArray<Limit> = [
	{ path: "VISION.md", capBytes: 5500, softBytes: 4125, label: "VISION.md" },
	{ path: "AGENTS.md", capBytes: 20000, softBytes: 15000, label: "AGENTS.md" },
];

function byteSize(absolutePath: string): number {
	return statSync(absolutePath).size;
}

describe("root doc size budget", () => {
	for (const limit of LIMITS) {
		const absolutePath = join(ROOT, limit.path);

		test(`${limit.label} is not empty`, () => {
			expect(byteSize(absolutePath)).toBeGreaterThan(0);
		});

		test(`${limit.label} stays within ${limit.capBytes} byte cap`, () => {
			const size = byteSize(absolutePath);
			expect(size).toBeLessThanOrEqual(limit.capBytes);
		});

		test(`${limit.label} reports budget usage`, () => {
			const size = byteSize(absolutePath);
			const pct = (size / limit.capBytes) * 100;
			const tier =
				size > limit.capBytes
					? "OVER"
					: size > limit.softBytes
						? "WARN"
						: "HEALTHY";

			// Bun's test runner does not have a built-in warning tier,
			// so surface the budget via a console message and pass
			// unless the file is over the cap. The hard cap test
			// above is the actual gate.
			const line = `[budget] ${limit.label}: ${size}/${limit.capBytes} bytes (${pct.toFixed(1)}%) — ${tier}`;
			if (tier === "WARN") {
				console.warn(line);
			} else {
				console.log(line);
			}

			expect(tier).not.toBe("OVER");
		});
	}
});
