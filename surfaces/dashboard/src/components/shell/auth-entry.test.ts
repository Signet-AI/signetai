import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthPage, authEntryKind } from "./auth-entry";

test("device header identifies the organization and instance", () => {
	const html = renderToStaticMarkup(
		createElement(
			AuthPage,
			{
				title: "Approve device sign-in",
				description: "Review your device.",
				organizationName: "Acme",
				instanceOrigin: "https://org.example",
			},
			"Device details",
		),
	);
	expect(html).toContain("Acme");
	expect(html).toContain("https://org.example");
	expect(html).toContain('aria-label="Signet"');
});

test("uses the daemon's printed bootstrap URL and device approval URL", () => {
	expect(authEntryKind("/auth/setup", "team")).toBe("claim");
	expect(authEntryKind("/auth/claim", "team")).toBe("claim");
	expect(authEntryKind("/auth/device", "team")).toBe("device");
	expect(authEntryKind("/auth/invite", "team")).toBe("invite");
	expect(authEntryKind("/auth/invite/one-use-token", "team")).toBe("invite");
});

test("local mode never exposes organization entry screens", () => {
	for (const path of ["/auth/setup", "/auth/claim", "/auth/device", "/auth/invite"])
		expect(authEntryKind(path, "local")).toBeNull();
	expect(authEntryKind("/auth/invited-something-else", "team")).toBeNull();
});
