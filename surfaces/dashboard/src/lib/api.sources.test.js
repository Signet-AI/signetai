// @ts-nocheck
import { afterEach, describe, expect, it } from "bun:test";
import { getSourceSnapshot, importSourceSnapshot } from "./api";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

function json(data, status = 200) {
	return new Response(JSON.stringify(data), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

describe("source api helpers", () => {
	it("exports source snapshots with the local Discord opt-in query", async () => {
		globalThis.fetch = async (input) => {
			expect(String(input).endsWith("/api/sources/discord%3Aabc/snapshot?includeLocalDiscord=true")).toBe(true);
			return json({ version: 1, artifacts: [] });
		};

		const res = await getSourceSnapshot("discord:abc", true);

		expect(res.snapshot).toEqual({ version: 1, artifacts: [] });
	});

	it("imports source snapshots through the scoped source route", async () => {
		globalThis.fetch = async (input, init) => {
			expect(String(input).endsWith("/api/sources/discord%3Aabc/snapshot/import")).toBe(true);
			expect(init?.method).toBe("POST");
			expect(init?.headers).toEqual({ "Content-Type": "application/json" });
			expect(JSON.parse(String(init?.body))).toEqual({ version: 1, artifacts: [] });
			return json({ imported: 2, skipped: { localDiscordArtifacts: 1 } });
		};

		const res = await importSourceSnapshot("discord:abc", { version: 1, artifacts: [] });

		expect(res).toEqual({ imported: 2, skipped: { localDiscordArtifacts: 1 } });
	});
});
