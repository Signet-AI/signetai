import { describe, expect, test } from "bun:test";

const dreamsSource = await Bun.file(new URL("./dreaming.tsx", import.meta.url)).text();

describe("dreaming responsive layout", () => {
	test("allows the complete workspace to grow into the main page scroll owner", () => {
		expect(dreamsSource).toMatch(/<div className="flex flex-col gap-3\.5">/);
	});

	test("uses a wrapping telemetry header instead of one clipped row", () => {
		expect(dreamsSource).toMatch(/dream-header flex flex-wrap/);
	});
});
