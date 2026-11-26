import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AuthPage, authEntryKind, DeviceApprovalResult, invitationContinuationHref } from "./auth-entry";

test("invitation SSO accepts only the daemon's same-instance continuation route", () => {
	expect(invitationContinuationHref("/api/auth/sso/start?continuation=one-use-code", "https://org.example")).toBe(
		"/api/auth/sso/start?continuation=one-use-code",
	);
	for (const path of [
		"https://other.example/api/auth/sso/start?continuation=code",
		"/api/auth/sso/start?invite=secret",
		"/api/auth/sso/start?continuation=code&invite=secret",
		"/api/auth/sso/start?continuation=code#secret",
	])
		expect(invitationContinuationHref(path, "https://org.example")).toBeNull();
});

test("only approved desktop flows offer the secret-free Return to Signet link", () => {
	const desktop = renderToStaticMarkup(createElement(DeviceApprovalResult, { client: "desktop", decision: "approve" }));
	expect(desktop).toContain('href="signet://auth/complete"');
	expect(desktop).toContain("Return to Signet");
	expect(desktop).not.toContain("signet://auth/complete?");
	for (const props of [
		{ client: "cli", decision: "approve" },
		{ client: "desktop", decision: "deny" },
	] as const)
		expect(renderToStaticMarkup(createElement(DeviceApprovalResult, props))).not.toContain("signet://");
});

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
