import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readSessionFileSnapshot } from "@signet/pi-extension-base";
import { PI_LIFECYCLE_CONFIG } from "./src/lifecycle.js";
import {
	HIDDEN_CLOCK_CUSTOM_TYPE,
	HIDDEN_RECALL_CUSTOM_TYPE,
	HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE,
} from "./src/types.js";

const EXCLUDED_CUSTOM_TYPES = PI_LIFECYCLE_CONFIG.excludedCustomTypes;

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
					customType: HIDDEN_SESSION_CONTEXT_CUSTOM_TYPE,
					content: "should stay hidden",
				}),
				JSON.stringify({
					type: "custom_message",
					customType: HIDDEN_RECALL_CUSTOM_TYPE,
					content: "should stay hidden too",
				}),
				JSON.stringify({
					type: "custom_message",
					customType: HIDDEN_CLOCK_CUSTOM_TYPE,
					content: "Current date/time: 2026-08-16T14:35:00-06:00 (America/Denver)",
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
