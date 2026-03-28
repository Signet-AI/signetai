import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionFileSnapshot } from "./src/transcript.js";

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

describe("readSessionFileSnapshot", () => {
	it("reconstructs transcript while excluding hidden Signet custom messages", () => {
		const dir = mkdtempSync(join(tmpdir(), "omp-session-"));
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
					customType: "signet-oh-my-pi-session-context",
					content: "should stay hidden",
				}),
				JSON.stringify({
					type: "custom_message",
					customType: "signet-oh-my-pi-hidden-recall",
					content: "should stay hidden too",
				}),
				JSON.stringify({
					type: "message",
					message: { role: "assistant", parts: [{ text: "Answer" }, { input_text: "details" }] },
				}),
			].join("\n"),
		);

		const snapshot = readSessionFileSnapshot(sessionFile);
		expect(snapshot).toEqual({
			loaded: true,
			sessionId: "session-123",
			project: "/tmp/project",
			transcript: "User: First line second line\nAssistant: Answer details",
		});
	});
});
