import { describe, expect, test } from "bun:test";

const topbarSource = await Bun.file(new URL("./topbar.tsx", import.meta.url)).text();
const sidebarSource = await Bun.file(new URL("./sidebar.tsx", import.meta.url)).text();
const settingsSource = await Bun.file(new URL("../../views/settings.tsx", import.meta.url)).text();

describe("mobile dashboard controls", () => {
	test("keeps theme and Settings alongside notifications only in a true mobile shell", () => {
		expect(topbarSource).toContain("mobileShell && <ModeToggle");
		expect(topbarSource).toContain('mobileShell && (');
		expect(topbarSource).toContain('aria-label="Settings"');
		expect(topbarSource).toContain('mobileShell ? "size-11" : "size-8"');
	});

	test("gives drawer routes and Settings categories mobile-sized hit areas", () => {
		expect(sidebarSource).toContain("max-sm:min-h-11 max-sm:touch-manipulation");
		expect(settingsSource).toMatch(/min-h-11[\s\S]*touch-manipulation[\s\S]*sm:min-h-0/);
		expect(settingsSource).toContain("h-11 w-full touch-manipulation");
		expect(settingsSource).toContain("function TouchSwitch");
	});
});
