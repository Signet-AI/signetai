import { describe, expect, test } from "bun:test";
import { createOAuthNavigation, safeOAuthHref } from "./oauth-navigation";

describe("OAuth navigation", () => {
	test("uses the desktop bridge without creating a popup", async () => {
		const opened: string[] = [];
		let popups = 0;
		const navigation = createOAuthNavigation({
			bridge: { openExternal: async (url) => void opened.push(url) },
			popup: () => {
				popups += 1;
				return null;
			},
			reportError: () => undefined,
			clearError: () => undefined,
		});

		expect(navigation.open()).toBe(true);
		navigation.navigate("https://auth.openai.com/oauth/authorize");
		await Promise.resolve();
		navigation.navigate("https://auth.openai.com/oauth/authorize");

		expect(popups).toBe(0);
		expect(opened).toEqual(["https://auth.openai.com/oauth/authorize"]);
	});

	test("reuses a browser popup and rejects non-HTTPS URLs", () => {
		const popup = { closed: false, location: { href: "about:blank" }, close: () => undefined };
		let popups = 0;
		const errors: string[] = [];
		const navigation = createOAuthNavigation({
			bridge: null,
			popup: () => {
				popups += 1;
				return popup;
			},
			reportError: (message) => errors.push(message),
			clearError: () => undefined,
		});

		expect(navigation.open()).toBe(true);
		expect(navigation.open()).toBe(true);
		navigation.navigate("https://auth.openai.com/oauth/authorize");
		navigation.navigate("http://auth.openai.com/oauth/authorize");

		expect(popups).toBe(1);
		expect(popup.location.href).toBe("https://auth.openai.com/oauth/authorize");
		expect(errors).toEqual(["The provider returned an invalid sign-in URL."]);
	});

	test("accepts only HTTPS URLs with a hostname", () => {
		expect(safeOAuthHref("https://auth.openai.com/oauth/authorize")).toBe("https://auth.openai.com/oauth/authorize");
		expect(safeOAuthHref("http://auth.openai.com/oauth/authorize")).toBeNull();
		expect(safeOAuthHref("https://")).toBeNull();
	});
});
