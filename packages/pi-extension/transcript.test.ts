import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionFileSnapshot } from "@signet/extension-base";
import { HIDDEN_RECALL_CUSTOM_TYPE, HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE } from "./src/types.js";

const EXCLUDED_CUSTOM_TYPES: ReadonlySet<string> = new Set([
	HIDDEN_RECALL_CUSTOM_TYPE,
	HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE,
]);

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("readSessionFileSnapshot", () => {
	it("reconstructs transcript while excluding hidden Signet custom messages", () => {
		const dir = mkdtempSync(join(tmpdir(), "pi-session-"));
		tempDirs.push(dir);
		const sessionFile = join(dir, "session.jsonl");

		writeFileSync(
			sessionFile,
			[
				JSON.stringify({ type: "session", id: "session-123", cwd: "/tmp/project" }),
				JSON.stringify({
					type: "message",
					message: { role: "user", content: "  First line\n second line  " },
				}),
				JSON.stringify({
					type: "custom_message",
					customType: "signet-pi-session-context",
					content: "should stay hidden",
				}),
				JSON.stringify({
					type: "custom_message",
					customType: "signet-pi-hidden-recall",
					content: "should stay hidden too",
				}),
				JSON.stringify({
					type: "message",
					message: { role: "assistant", parts: [{ text: "Answer" }, { input_text: "details" }] },
				}),
			].join("\n"),
		);

		const snapshot = readSessionFileSnapshot(sessionFile, EXCLUDED_CUSTOM_TYPES);
		expect(snapshot).toEqual({
			loaded: true,
			sessionId: "session-123",
			project: "/tmp/project",
			transcript: "User: First line second line\nAssistant: Answer details",
		});
	});
});
