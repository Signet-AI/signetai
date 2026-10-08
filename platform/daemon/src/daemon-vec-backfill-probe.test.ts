import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const previousSignetPath = process.env.SIGNET_PATH;
const agentsDir = mkdtempSync(join(tmpdir(), "signet-vec-backfill-probe-"));
process.env.SIGNET_PATH = agentsDir;
const { vecBackfillProbeRetryDelayMs } = await import("./daemon");

afterAll(() => {
	rmSync(agentsDir, { recursive: true, force: true });
	if (previousSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
	else process.env.SIGNET_PATH = previousSignetPath;
});

test("the vector backfill probe waits out a busy owner instead of giving up after one retry", () => {
	const ownerDelays: number[] = [];
	for (let attempt = 0; ; attempt++) {
		const delay = vecBackfillProbeRetryDelayMs(attempt, true);
		if (delay === null) break;
		ownerDelays.push(delay);
	}
	expect(ownerDelays).toEqual([1_000, 2_000, 4_000, 8_000, 16_000, 30_000, 30_000, 30_000, 30_000, 30_000]);
	expect(ownerDelays.reduce((total, delay) => total + delay, 0)).toBeGreaterThan(60_000);
	expect(vecBackfillProbeRetryDelayMs(0, false)).toBe(1_000);
	expect(vecBackfillProbeRetryDelayMs(1, false)).toBeNull();
});
