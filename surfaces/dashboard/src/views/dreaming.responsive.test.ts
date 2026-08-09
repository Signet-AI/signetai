import { describe, expect, test } from "bun:test";

const dreamsSource = await Bun.file(new URL("./dreaming.tsx", import.meta.url)).text();

describe("dreaming responsive layout", () => {
	test("allows the complete workspace to grow into the main page scroll owner", () => {
		expect(dreamsSource).toMatch(/<div className="flex flex-col gap-3\.5">/);
	});

	test("uses a responsive telemetry grid instead of letting wrapped stats overlap page content", () => {
		expect(dreamsSource).toContain('className="dream-header grid grid-cols-2');
		expect(dreamsSource).toContain('className="col-span-full flex flex-wrap');
	});

	test("scales telemetry values rather than truncating them in narrow grid cells", () => {
		expect(dreamsSource).toContain("text-[clamp(0.6875rem,2vw,0.875rem)]");
		expect(dreamsSource).not.toContain('"truncate font-mono text-[14px]');
	});
});
