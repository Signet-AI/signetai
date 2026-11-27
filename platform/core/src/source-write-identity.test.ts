import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { addObsidianSource, loadSourcesConfig } from "./sources-config";

test("configured folder sources durably bind admitted agent and author", () => {
	const dir = mkdtempSync(join(tmpdir(), "source-identity-"));
	const root = join(dir, "vault");
	mkdirSync(root);
	try {
		const writeIdentity = { agentId: "alice-agent", authorUserId: "alice", authorCredential: "session:alice" };
		const input = { root, writeIdentity };
		const result = addObsidianSource(input, dir);
		expect(result.ok).toBe(true);
		expect(loadSourcesConfig(dir).sources[0]?.writeIdentity).toEqual(writeIdentity);
		const conflict = addObsidianSource(
			{ root, writeIdentity: { ...writeIdentity, agentId: "bob-agent", authorUserId: "bob" } },
			dir,
		);
		expect(conflict.ok).toBe(false);
		expect(loadSourcesConfig(dir).sources[0]?.writeIdentity).toEqual(writeIdentity);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
});
