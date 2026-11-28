import assert from "node:assert/strict";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import inventory from "./operator-local-gaps.json";
import { hostGapCases } from "./host-gap-cases";
import { HostFixture } from "./host-fixture";

let fixture: HostFixture | undefined;
const completed: string[] = [];
beforeAll(async () => {
	fixture = await HostFixture.create();
}, 60_000);
afterAll(async () => {
	console.info("HOST_GAP_PROVEN", JSON.stringify(completed));
	await fixture?.dispose();
}, 30_000);
test("gap proofs preserve all 61 operator inventory registrations", () => {
	expect(inventory).toHaveLength(61);
	expect(hostGapCases.map((entry) => entry.signature).sort()).toEqual(inventory.map((entry) => entry.signature).sort());
	expect(new Set(hostGapCases.map((entry) => entry.signature)).size).toBe(61);
});
describe("claimed organization host business operations", () => {
	for (const gap of inventory)
		test(gap.signature + (gap.input ? ` ${gap.input}` : ""), async () => {
			const host = fixture;
			assert(host);
			const entry = hostGapCases.find((item) => item.signature === gap.signature);
			assert(entry);
			try {
				await entry.run(host);
				completed.push(gap.signature);
			} catch (error) {
				throw new Error(
					`${gap.signature}: ${error instanceof Error ? error.message : String(error)}\nDaemon stderr: ${host.daemon.stderr.slice(-12_000)}`,
					{ cause: error },
				);
			}
		}, 60_000);
});
