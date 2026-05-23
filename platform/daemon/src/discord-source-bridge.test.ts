import { afterEach, beforeEach, describe, expect, it, mock } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SignetSourceEntry } from "../../core/src/sources-config";
import { closeDbAccessor } from "./db-accessor";
import { syncDiscordSource } from "./discord-source-bridge";
import { putSecret, resetSecretExecJobsForTests } from "./secrets.js";

const originalFetch = globalThis.fetch;
const originalSignetPath = process.env.SIGNET_PATH;
let agentsDir = "";

describe("syncDiscordSource", () => {
	beforeEach(() => {
		agentsDir = mkdtempSync(join(tmpdir(), "signet-discord-source-"));
		process.env.SIGNET_PATH = agentsDir;
		mkdirSync(agentsDir, { recursive: true });
	});

	afterEach(() => {
		globalThis.fetch = originalFetch;
		resetSecretExecJobsForTests();
		closeDbAccessor();
		if (originalSignetPath === undefined) Reflect.deleteProperty(process.env, "SIGNET_PATH");
		else process.env.SIGNET_PATH = originalSignetPath;
	});

	it("reports skipped syncs when no Discord token can be resolved", async () => {
		const source: SignetSourceEntry = {
			id: "discord:test",
			kind: "discord",
			name: "Discord",
			root: "",
			enabled: true,
			mode: "read-only",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			settings: { guildIds: ["123456789012345678"], tokenRef: "MISSING_SECRET" },
		};

		const result = await syncDiscordSource(source, { agentsDir });
		expect(result).toEqual({ indexed: 0, syncedGuilds: 0 });
	});

	it("treats accessible but empty guilds as a successful sync", async () => {
		await putSecret("DISCORD_BOT_TOKEN", "discord-secret");
		const source: SignetSourceEntry = {
			id: "discord:test",
			kind: "discord",
			name: "Discord",
			root: "",
			enabled: true,
			mode: "read-only",
			createdAt: "2026-01-01T00:00:00.000Z",
			updatedAt: "2026-01-01T00:00:00.000Z",
			settings: { guildIds: ["123456789012345678"], tokenRef: "DISCORD_BOT_TOKEN" },
		};

		globalThis.fetch = mock((input: string | URL | Request) => {
			const url = String(input);
			if (url.endsWith("/guilds/123456789012345678")) {
				return Promise.resolve(Response.json({ id: "123456789012345678", name: "Guild" }));
			}
			if (url.endsWith("/guilds/123456789012345678/channels")) {
				return Promise.resolve(Response.json([]));
			}
			if (url.endsWith("/guilds/123456789012345678/threads/active")) {
				return Promise.resolve(Response.json({ threads: [] }));
			}
			throw new Error(`Unexpected fetch: ${url}`);
		}) as typeof fetch;

		const result = await syncDiscordSource(source, { agentsDir });
		expect(result).toEqual({ indexed: 0, syncedGuilds: 1 });
	});
});
