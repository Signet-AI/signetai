import { describe, expect, test } from "bun:test";
import { desktopDashboardUrl, findDesktopDeepLink, parseDesktopDeepLink } from "./deep-link.js";

describe("desktop deep links", () => {
	test("maps setup and dashboard destinations to the internal app routes", () => {
		expect(desktopDashboardUrl("setup")).toBe("app://signet/#setup");
		expect(desktopDashboardUrl("dashboard")).toBe("app://signet/");
	});

	test("accepts only the dashboard and setup destinations", () => {
		expect(parseDesktopDeepLink("signet://dashboard")).toBe("dashboard");
		expect(parseDesktopDeepLink("signet://setup")).toBe("setup");
		expect(parseDesktopDeepLink("https://example.com/#setup")).toBeNull();
		expect(parseDesktopDeepLink("signet://other")).toBeNull();
		expect(parseDesktopDeepLink("signet://setup/extra")).toBeNull();
		expect(parseDesktopDeepLink("signet://setup?workspace=/tmp/other")).toBeNull();
		expect(parseDesktopDeepLink("signet://user@setup")).toBeNull();
	});

	test("selects the last valid desktop link from operating-system arguments", () => {
		expect(findDesktopDeepLink(["/Applications/Signet.app", "signet://dashboard", "signet://setup"])).toBe("setup");
		expect(findDesktopDeepLink(["--no-sandbox", "https://example.com"])).toBeNull();
	});
});
