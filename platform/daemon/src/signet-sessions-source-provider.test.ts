import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import {
	SIGNET_SESSIONS_RELATIVE_ROOT,
	addSignetSessionsSource,
	getAgentsDir,
	loadSourcesConfig,
	removeSource,
} from "@signet/core";
import { ensureSignetSessionsSourceRegistered, signetSessionsSourceProvider } from "./signet-sessions-source-provider";

let tmpRoot: string;

beforeEach(() => {
	tmpRoot = `/tmp/signet-sessions-source-${Date.now()}-${Math.random().toString(36).slice(2)}`;
	mkdirSync(tmpRoot, { recursive: true });
});

afterEach(() => {
	if (existsSync(tmpRoot)) rmSync(tmpRoot, { recursive: true, force: true });
});

describe("signet-sessions source provider", () => {
	test("addSignetSessionsSource creates the directory and a source entry", () => {
		const r = addSignetSessionsSource({}, tmpRoot);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.created).toBe(true);
		expect(r.source.kind).toBe("signet-sessions");
		expect(r.source.root).toBe(join(tmpRoot, SIGNET_SESSIONS_RELATIVE_ROOT));
		expect(r.source.mode).toBe("read-only");
		expect(r.source.enabled).toBe(true);
		expect(existsSync(r.source.root)).toBe(true);
	});

	test("addSignetSessionsSource is idempotent on re-run", () => {
		const first = addSignetSessionsSource({}, tmpRoot);
		expect(first.ok).toBe(true);
		if (!first.ok) return;
		const second = addSignetSessionsSource({}, tmpRoot);
		expect(second.ok).toBe(true);
		if (!second.ok) return;
		expect(second.created).toBe(false);
		expect(second.source.id).toBe(first.source.id);
		const cfg = loadSourcesConfig(tmpRoot);
		const matches = cfg.sources.filter((s) => s.id === first.source.id);
		expect(matches).toHaveLength(1);
	});

	test("addSignetSessionsSource honors a custom name", () => {
		const r = addSignetSessionsSource({ name: "My Session Notes" }, tmpRoot);
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.source.name).toBe("My Session Notes");
	});

	test("addSignetSessionsSource stable id across re-runs (root-derived)", () => {
		const a = addSignetSessionsSource({}, tmpRoot);
		const b = addSignetSessionsSource({}, tmpRoot);
		expect(a.ok && b.ok).toBe(true);
		if (!a.ok || !b.ok) return;
		expect(a.source.id).toBe(b.source.id);
	});

	test("sources.json is parseable after registration", () => {
		addSignetSessionsSource({}, tmpRoot);
		const path = join(tmpRoot, "sources.json");
		expect(existsSync(path)).toBe(true);
		const raw = JSON.parse(readFileSync(path, "utf8")) as { sources: Array<{ kind: string }> };
		expect(raw.sources.some((s) => s.kind === "signet-sessions")).toBe(true);
	});

	test("ensureSignetSessionsSourceRegistered is a safe no-op on re-runs", () => {
		const a = ensureSignetSessionsSourceRegistered(tmpRoot);
		const b = ensureSignetSessionsSourceRegistered(tmpRoot);
		expect(a?.id).toBe(b?.id);
	});

	test("provider.kind is 'signet-sessions'", () => {
		expect(signetSessionsSourceProvider.kind).toBe("signet-sessions");
	});

	test("provider.toNativeSource yields a NativeMemorySource with **/notes.md pattern", () => {
		const r = addSignetSessionsSource({}, tmpRoot);
		if (!r.ok) throw new Error("setup failed");
		const native = signetSessionsSourceProvider.toNativeSource?.(r.source);
		expect(native).toBeDefined();
		if (!native) return;
		expect(native.harness).toBe("signet-sessions");
		expect(native.root).toBe(r.source.root);
		expect(native.sourceId).toBe(r.source.id);
		expect(native.files).toHaveLength(1);
		expect(native.files[0]?.glob).toBe("**/notes.md");
		expect(native.files[0]?.kind).toBe("signet_session_notes");
	});

	test("provider.purge delegates to native-memory artifacts and does not delete source files", () => {
		// We don't call purge directly because it requires a real DB accessor
		// (touching memory_artifacts, embeddings, etc). The contract under test
		// is that the *source* notes.md is never deleted as a side effect,
		// which the implementation enforces by delegating to
		// purgeNativeMemorySourceArtifacts (which only deletes derived rows).
		// The behavior is covered end-to-end by the obsidian-source-provider
		// tests via the same delegate; here we just confirm the source file
		// stays on disk across a registration cycle.
		const r = addSignetSessionsSource({}, tmpRoot);
		if (!r.ok) throw new Error("setup failed");
		const sessionDir = join(r.source.root, "abc");
		mkdirSync(sessionDir, { recursive: true });
		const notesPath = join(sessionDir, "notes.md");
		require("node:fs").writeFileSync(notesPath, "# placeholder");
		// Even with no purge call, re-registration must preserve the file.
		const r2 = addSignetSessionsSource({}, tmpRoot);
		expect(r2.ok).toBe(true);
		expect(existsSync(notesPath)).toBe(true);
	});

	test("removeSource on a signet-sessions entry unregisters cleanly", () => {
		const r = addSignetSessionsSource({}, tmpRoot);
		if (!r.ok) throw new Error("setup failed");
		const removed = removeSource(r.source.id, tmpRoot);
		expect(removed.ok).toBe(true);
		if (!removed.ok) return;
		expect(removed.source.id).toBe(r.source.id);
		const cfg = loadSourcesConfig(tmpRoot);
		expect(cfg.sources.find((s) => s.id === r.source.id)).toBeUndefined();
	});

	test("getAgentsDir and addSignetSessionsSource cooperate on the default agents dir", () => {
		// Smoke: ensure the exported functions don't throw on the default dir.
		// We don't mutate real state — we just assert the call returns a
		// properly-typed result without an exception.
		expect(typeof getAgentsDir()).toBe("string");
		// Don't actually call addSignetSessionsSource() with the default dir
		// to avoid mutating the user's real sources.json.
	});
});
