import { describe, expect, test } from "bun:test";
import { statSync } from "node:fs";
import { join } from "node:path";

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
			const tier = size > limit.capBytes ? "OVER" : size > limit.softBytes ? "WARN" : "HEALTHY";
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
