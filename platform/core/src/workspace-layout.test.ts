import { describe, expect, it } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	createFreshWorkspaceV2,
	persistWorkspaceLayout,
	resolveWorkspaceLayout,
	serializeWorkspaceLayout,
	type WorkspaceLayoutOverrides,
} from "./workspace-layout";

const env = (configHome: string): NodeJS.ProcessEnv => ({ XDG_CONFIG_HOME: configHome });

function overrides(root: string): WorkspaceLayoutOverrides {
	return { database: join(root, "custom.db"), transcripts: join(root, "custom-transcripts") };
}

describe("canonical workspace layout resolver", () => {
	it("resolves v1 persisted layout with canonical legacy paths", () => {
		const root = mkdtempSync(join(tmpdir(), "layout-v1-"));
		try {
			persistWorkspaceLayout(root, { env: env(join(root, "config")), version: 1 });
			const layout = resolveWorkspaceLayout(root, { env: env(join(root, "config")) });
			expect(layout.version).toBe(1);
			expect(layout.database).toBe(join(root, "memory", "memories.db"));
			expect(layout.transcripts).toBe(join(root, "memory"));
			expect(layout.runtime).toBe(join(root, ".daemon"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("resolves v2 persisted layout and custom overrides", () => {
		const root = mkdtempSync(join(tmpdir(), "layout-v2-"));
		try {
			persistWorkspaceLayout(root, { env: env(join(root, "config")), version: 2, overrides: overrides(root) });
			const layout = resolveWorkspaceLayout(root, { env: env(join(root, "config")) });
			expect(layout.version).toBe(2);
			expect(layout.database).toBe(join(root, "custom.db"));
			expect(layout.transcripts).toBe(join(root, "custom-transcripts"));
			expect(layout.data).toBe(join(root, "data"));
			expect(layout.files).toBe(join(root, "files"));
			expect(layout.secrets).toBe(join(root, ".secrets"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("refuses unknown layout versions instead of falling back", () => {
		const root = mkdtempSync(join(tmpdir(), "layout-unknown-"));
		try {
			persistWorkspaceLayout(root, { env: env(join(root, "config")), version: 9 as never });
			expect(() => resolveWorkspaceLayout(root, { env: env(join(root, "config")) })).toThrow(
				/unsupported workspace layout version/,
			);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("creates fresh v2 components and an empty import inbox without a source", () => {
		const root = mkdtempSync(join(tmpdir(), "layout-fresh-"));
		try {
			const result = createFreshWorkspaceV2(root, { env: env(join(root, "config")) });
			expect(result.version).toBe(2);
			expect(result.cache).toBe(join(root, "cache"));
			for (const directory of ["files", "data", "transcripts", "runtime", "cache", ".secrets", "skills"]) {
				expect(existsSync(join(root, directory))).toBe(true);
			}
			expect(existsSync(join(root, "files", "sources.json"))).toBe(false);
			expect(JSON.parse(readFileSync(join(root, "workspace-layout.json"), "utf8")).version).toBe(2);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves v1 overrides and merges explicit overrides during upgrade", () => {
		const root = mkdtempSync(join(tmpdir(), "layout-upgrade-overrides-"));
		try {
			persistWorkspaceLayout(root, { version: 1, overrides: { database: "../db", transcripts: "../transcripts", runtime: "../runtime" } });
			const result = createFreshWorkspaceV2(root, { overrides: { cache: "../cache" } });
			expect(result.database).toBe(resolve(root, "../db"));
			expect(result.transcripts).toBe(resolve(root, "../transcripts"));
			expect(result.runtime).toBe(resolve(root, "../runtime"));
			expect(result.cache).toBe(resolve(root, "../cache"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("does not delete a pre-existing manual inbox entry", () => {
		const root = mkdtempSync(join(tmpdir(), "layout-existing-inbox-"));
		try {
			const files = join(root, "files");
			mkdirSync(files);
			writeFileSync(join(files, "sources.json"), "manual");
			createFreshWorkspaceV2(root, { env: env(join(root, "config")) });
			expect(readFileSync(join(files, "sources.json"), "utf8")).toBe("manual");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("preserves persisted custom paths when fresh setup is resumed", () => {
		const root = mkdtempSync(join(tmpdir(), "layout-resume-"));
		try {
			persistWorkspaceLayout(root, {
				version: 2,
				overrides: { database: "../durable/signet.db", transcripts: "../transcripts" },
			});
			const result = createFreshWorkspaceV2(root);
			expect(result.database).toBe(resolve(root, "../durable/signet.db"));
			expect(result.transcripts).toBe(resolve(root, "../transcripts"));
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("serializes canonical layout bytes without writing the destination", () => {
		const bytes = serializeWorkspaceLayout({ version: 2, overrides: { database: "custom.db" } });
		expect(new TextDecoder().decode(bytes)).toBe(
			'{\n  "version": 2,\n  "overrides": {\n    "database": "custom.db"\n  }\n}\n',
		);
	});
});
