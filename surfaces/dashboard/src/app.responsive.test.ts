import { describe, expect, test } from "bun:test";

const appSource = await Bun.file(new URL("./app.tsx", import.meta.url)).text();
const mobileShellSource = await Bun.file(new URL("./lib/mobile-shell.ts", import.meta.url)).text();

describe("dashboard responsive shell", () => {
	test("keeps a vertical scroll owner for page content instead of clipping it", () => {
		expect(appSource).toMatch(/sig-content[\s\S]*overflow-y-auto[\s\S]*overflow-x-hidden/);
	});

	test("activates the mobile shell only for a narrow coarse-pointer viewport", () => {
		expect(mobileShellSource).toContain("(max-width: 639px) and (hover: none) and (pointer: coarse)");
		expect(appSource).toContain("const mobileShell = useMobileShell();");
		expect(appSource).toContain('mobileShell ? "grid-cols-1" : "grid-cols-[248px_1fr]"');
	});

	test("keeps desktop-pointer windows out of the mobile drawer even when scaled", () => {
		expect(appSource).toContain('mobileShell && "fixed inset-x-0 top-[52px] z-50');
		expect(appSource).toContain("!mobileShell && <WindowChrome />");
		expect(appSource).not.toContain("max-sm:fixed");
	});

	test("drops mobile navigation down from the top and lets the same menu button close it", () => {
		expect(appSource).toMatch(/top-\[52px\][\s\S]*-translate-y-full[\s\S]*invisible/);
		expect(appSource).toContain("setNavOpen((open) => !open)");
	});
});
