import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SignetSourceEntry } from "@signet/core";
import { closeDbAccessor, getDbAccessor, initDbAccessor } from "./db-accessor";
import { createDbOwnerClient } from "./db-owner-client";
import { closeRegisteredDbOwnerMaintenance, createDbOwnerMaintenance, registerDbOwnerMaintenance } from "./db-owner-maintenance";
import { setActiveTelemetry, type TelemetryCollector } from "./telemetry";
import {
	flushPendingSourceLifecycleTelemetry,
	recordSourceIndexOperation,
	recordSourceFreshness,
	sourceClassForKind,
	sourceCountBucket,
	sourceDurationBucket,
	sourceFailureClass,
	sourceLagBucket,
	sourceSizeBucket,
	trackSourceLifecycleWrite,
} from "./source-lifecycle-telemetry";

describe("source lifecycle telemetry contract", () => {
	let directory: string | null = null;
	let owner: ReturnType<typeof createDbOwnerClient> | null = null;

	afterEach(async () => {
		setActiveTelemetry(undefined);
		await closeRegisteredDbOwnerMaintenance();
		await owner?.close();
		owner = null;
		closeDbAccessor();
		if (directory !== null) rmSync(directory, { recursive: true, force: true });
		directory = null;
	});

	it("maps providers into a fixed taxonomy instead of forwarding provider input", () => {
		expect(sourceClassForKind("obsidian")).toBe("note_vault");
		expect(sourceClassForKind("github")).toBe("repository");
		expect(sourceClassForKind("user-defined-provider-with-a-path-/Users/alice/vault")).toBe("other");
	});

	it("bounds corpus, size, duration, and freshness values into finite buckets", () => {
		expect(sourceCountBucket(Number.MAX_SAFE_INTEGER)).toBe("10k_plus");
		expect(sourceCountBucket(-1)).toBe("0");
		expect(sourceSizeBucket(1_000_000_000)).toBe("1gb_plus");
		expect(sourceDurationBucket(Number.POSITIVE_INFINITY)).toBe("unknown");
		expect(sourceLagBucket(Number.MAX_SAFE_INTEGER)).toBe("7d_plus");
	});

	it("classifies failures without exposing their message", () => {
		expect(sourceFailureClass(new Error("401 https://private.example/user-token"))).toBe("authentication");
		expect(sourceFailureClass({ message: "429 rate limit" })).toBe("rate_limited");
		expect(sourceFailureClass(new Error("Obsidian root is required"))).toBe("configuration");
		expect(sourceFailureClass(new Error("Invalid Discord source configuration"))).toBe("configuration");
		expect(sourceFailureClass(new Error("invalid configuration"))).toBe("configuration");
		expect(sourceFailureClass(new Error("unexpected implementation detail with /Users/alice/private.md"))).toBe(
			"unknown",
		);
	});

	it("drains tracked fire-and-forget writes before shutdown continues", async () => {
		let release: (() => void) | undefined;
		let settled = false;
		const operation = new Promise<void>((resolve) => {
			release = () => {
				settled = true;
				resolve();
			};
		});
		void trackSourceLifecycleWrite(operation);

		let flushed = false;
		const drain = flushPendingSourceLifecycleTelemetry().then(() => {
			flushed = true;
		});
		await Promise.resolve();
		expect(flushed).toBe(false);

		release?.();
		await drain;
		expect(settled).toBe(true);
		expect(flushed).toBe(true);
	});

	it("keeps lifecycle persistence on the owner and does not swallow failures", () => {
		const source = readFileSync(new URL("./source-lifecycle-telemetry.ts", import.meta.url), "utf8");
		expect(source).toContain("dbOwnerBatch");
		expect(source).toContain("dbOwnerQuery");
		expect(source).not.toContain("getDbAccessor");
		expect(source).not.toContain("withWriteTxAsync");
		expect(source).not.toContain("withReadDbAsync");
		expect(source).not.toContain("catch {\n		// Best effort");
		expect(source).toContain("rethrowLifecycleFailure");
	});

	it("serializes lifecycle claims so concurrent index and freshness recorders do not duplicate milestones", async () => {
		directory = mkdtempSync(join(tmpdir(), "signet-source-lifecycle-"));
		const dbPath = join(directory, "memories.db");
		initDbAccessor(dbPath);
		owner = createDbOwnerClient({ dbPath });
		await owner.start();
		registerDbOwnerMaintenance(createDbOwnerMaintenance({ dbPath, owner }));
		const events: Array<{ readonly event: string; readonly properties: Readonly<Record<string, unknown>> }> = [];
		const collector = {
			enabled: true,
			record: (event: string, properties: Readonly<Record<string, unknown>>) => events.push({ event, properties }),
		} as unknown as TelemetryCollector;
		setActiveTelemetry(collector);
		const source: SignetSourceEntry = {
			id: "obsidian:atomic-lifecycle",
			kind: "obsidian",
			name: "Atomic lifecycle",
			root: directory,
			enabled: true,
			mode: "read-only",
			createdAt: new Date().toISOString(),
			updatedAt: new Date().toISOString(),
			providerSettings: { syncMode: "gateway-tail" },
		};

		await Promise.all(
			Array.from({ length: 20 }, (_, index) =>
				recordSourceIndexOperation({
					source,
					agentId: "agent-atomic",
					discovered: index + 1,
					accepted: 1,
					durationMs: 10,
					outcome: "success",
					searchable: true,
					sourceBytes: 100,
				}),
			),
		);
		await Promise.all(Array.from({ length: 20 }, () => recordSourceFreshness(source, "agent-atomic")));

		const lifecycle = events.filter(({ event }) => event === "source.lifecycle");
		expect(lifecycle.filter(({ properties }) => properties.phase === "index")).toHaveLength(20);
		expect(lifecycle.filter(({ properties }) => properties.readiness === "indexed")).toHaveLength(1);
		expect(lifecycle.filter(({ properties }) => properties.readiness === "searchable")).toHaveLength(1);
		expect(lifecycle.filter(({ properties }) => properties.phase === "freshness")).toHaveLength(1);
		const state = await getDbAccessor().withReadDbAsync(
			(db) =>
				db
					.prepare(
						"SELECT first_indexed_at, first_searchable_at, last_success_at, last_freshness_event_at FROM source_lifecycle_state WHERE agent_id = ?",
					)
					.get("agent-atomic") as {
					readonly first_indexed_at: string | null;
					readonly first_searchable_at: string | null;
					readonly last_success_at: string | null;
					readonly last_freshness_event_at: string | null;
				},
		);
		expect(state.first_indexed_at).toBeString();
		expect(state.first_searchable_at).toBeString();
		expect(state.last_success_at).toBeString();
		expect(state.last_freshness_event_at).toBeString();
	});
});
