import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { writeCodexNativeNote } from "./memory-routes";

let dir: string | undefined;
const originalCodexHome = process.env.CODEX_HOME;

afterEach(() => {
	if (dir) {
		rmSync(dir, { recursive: true, force: true });
		dir = undefined;
	}
	if (originalCodexHome === undefined) {
		Reflect.deleteProperty(process.env, "CODEX_HOME");
	} else {
		process.env.CODEX_HOME = originalCodexHome;
	}
});

describe("writeCodexNativeNote", () => {
	it("uses exclusive create and retries same timestamp/title collisions", () => {
		dir = mkdtempSync(join(tmpdir(), "signet-codex-note-route-"));
		process.env.CODEX_HOME = dir;
		const now = new Date("2026-05-24T20:01:02.345Z");
		let suffix = 0;

		const first = writeCodexNativeNote(
			{ content: "first durable note", title: "Collision", tags: "codex" },
			{ now, uniqueSuffix: () => `retry-${(suffix += 1).toString()}` },
		);
		const second = writeCodexNativeNote(
			{ content: "second durable note", title: "Collision", tags: "codex" },
			{ now, uniqueSuffix: () => `retry-${(suffix += 1).toString()}` },
		);

		expect(first).not.toBe(second);
		expect(basename(first)).toBe("2026-05-24T20-01-02-345Z-collision.md");
		expect(basename(second)).toBe("2026-05-24T20-01-02-345Z-collision-retry-1.md");
		expect(readFileSync(first, "utf-8")).toContain("first durable note");
		expect(readFileSync(second, "utf-8")).toContain("second durable note");
	});
});
