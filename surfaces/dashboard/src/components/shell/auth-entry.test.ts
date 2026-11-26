import { expect, test } from "bun:test";
import { authEntryKind } from "./auth-entry";

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
