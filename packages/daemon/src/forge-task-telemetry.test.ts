import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { closeDbAccessor, initDbAccessor } from "./db-accessor";
import {
	ingestForgeTaskTelemetry,
	listForgeTaskTelemetry,
	resetForgeTaskTelemetryForTests,
} from "./forge-task-telemetry";

function tmpDbPath(): string {
	const dir = join(tmpdir(), `signet-forge-telemetry-${Date.now()}-${Math.random().toString(36).slice(2)}`);
	mkdirSync(dir, { recursive: true });
	return join(dir, "memories.db");
}

describe("forge task telemetry", () => {
	const cleanupDirs: string[] = [];

	afterEach(() => {
		closeDbAccessor();
		resetForgeTaskTelemetryForTests();
		for (const dir of cleanupDirs) {
			if (existsSync(dir)) rmSync(dir, { recursive: true, force: true });
		}
		cleanupDirs.length = 0;
	});

	test("assigns monotonic cursor+sequence per session", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);

		ingestForgeTaskTelemetry({
			sessionKey: "session:a",
			harness: "forge",
			event: { task_id: "t1", kind: "tool", phase: "started", name: "Read" },
			receivedAt: "2026-03-31T21:00:00.000Z",
		});
		ingestForgeTaskTelemetry({
			sessionKey: "session:a",
			harness: "forge",
			event: { task_id: "t1", kind: "tool", phase: "succeeded", name: "Read" },
			receivedAt: "2026-03-31T21:00:01.000Z",
		});

		const events = listForgeTaskTelemetry({ sessionKey: "session:a", limit: 10 });
		expect(events).toHaveLength(2);
		expect(events[0]?.sequence).toBe(1);
		expect(events[1]?.sequence).toBe(2);
		expect(Number(events[0]?.cursor)).toBeLessThan(Number(events[1]?.cursor));
	});

	test("supports filtered list queries", () => {
		const dbPath = tmpDbPath();
		cleanupDirs.push(join(dbPath, ".."));
		initDbAccessor(dbPath);

		ingestForgeTaskTelemetry({
			sessionKey: "session:b",
			harness: "forge",
			event: {
				task_id: "x1",
				kind: "tool",
				phase: "failed",
				name: "Bash",
				meta: { policy_denied: true, policy_reason: "command_not_allowlisted" },
			},
			receivedAt: "2026-03-31T21:10:00.000Z",
		});
		ingestForgeTaskTelemetry({
			sessionKey: "session:b",
			harness: "forge",
			event: { task_id: "x2", kind: "tool", phase: "succeeded", name: "Read" },
			receivedAt: "2026-03-31T21:10:01.000Z",
		});

		const denied = listForgeTaskTelemetry({
			sessionKey: "session:b",
			policyDeniedOnly: true,
			limit: 10,
		});
		expect(denied).toHaveLength(1);
		expect((denied[0]?.event as { name?: string })?.name).toBe("Bash");

		const readOnly = listForgeTaskTelemetry({
			sessionKey: "session:b",
			name: "Read",
			phase: "succeeded",
			limit: 10,
		});
		expect(readOnly).toHaveLength(1);
		expect((readOnly[0]?.event as { task_id?: string })?.task_id).toBe("x2");
	});
});
