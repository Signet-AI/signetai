import { describe, expect, test } from "bun:test";

const homeSource = await Bun.file(new URL("./home.tsx", import.meta.url)).text();
const kpiSource = await Bun.file(new URL("../components/home/kpi.tsx", import.meta.url)).text();

describe("home responsive layout", () => {
	test("keeps every time range available by allowing the control group to wrap", () => {
		expect(homeSource).toMatch(/HomeControls[\s\S]*flex-wrap/);
	});

	test("puts trailing controls on a full KPI row instead of one narrow grid cell", () => {
		expect(kpiSource).toMatch(/col-span-full/);
	});
});
