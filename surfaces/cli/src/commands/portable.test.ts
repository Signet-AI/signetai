import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerPortableCommands } from "./portable";

async function runImport(
	workspace: string,
	bundle: string,
	args: readonly string[] = [],
	owned = false,
): Promise<void> {
	const program = new Command();
	registerPortableCommands(program, { AGENTS_DIR: workspace, daemonOwnsWorkspace: async () => owned });
	await program.parseAsync(["node", "signet", "import", bundle, "--json", ...args]);
}

afterEach(() => {
	process.exitCode = 0;
});

describe("signet import <bundle>", () => {
	test("creates a v2 workspace when importing into a workspace without a database", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-portable-import-"));
		try {
			const workspace = join(root, "workspace");
			const bundle = join(root, "bundle.json");
			writeFileSync(bundle, JSON.stringify({ "identity/AGENTS.md": "# Imported\n" }));

			await runImport(workspace, bundle);

			expect(JSON.parse(readFileSync(join(workspace, "workspace-layout.json"), "utf-8")).version).toBe(2);
			expect(existsSync(join(workspace, "data", "signet.db"))).toBe(true);
			expect(readFileSync(join(workspace, "AGENTS.md"), "utf-8")).toBe("# Imported\n");
			expect(existsSync(join(workspace, "memory"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("keeps an existing v1 database in place", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-portable-import-v1-"));
		try {
			const workspace = join(root, "workspace");
			const bundle = join(root, "bundle.json");
			mkdirSync(join(workspace, "memory"), { recursive: true });
			writeFileSync(join(workspace, "memory", "memories.db"), "");
			writeFileSync(bundle, JSON.stringify({ "identity/AGENTS.md": "# Imported\n" }));

			await runImport(workspace, bundle);

			expect(existsSync(join(workspace, "workspace-layout.json"))).toBe(false);
			expect(existsSync(join(workspace, "data"))).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("refuses to touch the workspace while a daemon owns it", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-portable-import-owned-"));
		try {
			const workspace = join(root, "workspace");
			const bundle = join(root, "bundle.json");
			writeFileSync(bundle, JSON.stringify({ "identity/AGENTS.md": "# Imported\n" }));

			await runImport(workspace, bundle, [], true);

			expect(process.exitCode).toBe(1);
			expect(existsSync(workspace)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects a bundle without agent identity before writing anything", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-portable-import-identity-"));
		try {
			const workspace = join(root, "workspace");
			const bundle = join(root, "bundle.json");
			writeFileSync(
				bundle,
				JSON.stringify({
					"identity/AGENTS.md": "# Imported\n",
					"memories.jsonl": JSON.stringify({ id: "m1", content: "legacy row" }),
				}),
			);

			await runImport(workspace, bundle);

			expect(process.exitCode).toBe(1);
			expect(existsSync(join(workspace, "AGENTS.md"))).toBe(false);
			const db = new Database(join(workspace, "data", "signet.db"), { readonly: true });
			try {
				expect(db.prepare("SELECT COUNT(*) AS n FROM memories").get()).toEqual({ n: 0 });
			} finally {
				db.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("preserves agent identity, scope, and visibility from the bundle", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-portable-import-scope-"));
		try {
			const workspace = join(root, "workspace");
			const bundle = join(root, "bundle.json");
			writeFileSync(
				bundle,
				JSON.stringify({
					"memories.jsonl": JSON.stringify({
						id: "m1",
						content: "alice note",
						agent_id: "alice",
						scope: "project-x",
						visibility: "private",
					}),
					"entities.jsonl": JSON.stringify({ id: "e1", name: "Thing", agent_id: "alice" }),
				}),
			);

			await runImport(workspace, bundle);

			expect(process.exitCode).not.toBe(1);
			const db = new Database(join(workspace, "data", "signet.db"), { readonly: true });
			try {
				expect(db.prepare("SELECT agent_id, scope, visibility FROM memories WHERE id = 'm1'").get()).toEqual({
					agent_id: "alice",
					scope: "project-x",
					visibility: "private",
				});
				expect(db.prepare("SELECT agent_id FROM entities WHERE id = 'e1'").get()).toEqual({ agent_id: "alice" });
			} finally {
				db.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("retargets a legacy bundle to an explicit agent as private memories", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-portable-import-target-"));
		try {
			const workspace = join(root, "workspace");
			const bundle = join(root, "bundle.json");
			writeFileSync(bundle, JSON.stringify({ "memories.jsonl": JSON.stringify({ id: "m1", content: "legacy row" }) }));

			await runImport(workspace, bundle, ["--agent", "bob"]);

			const db = new Database(join(workspace, "data", "signet.db"), { readonly: true });
			try {
				expect(db.prepare("SELECT agent_id, scope, visibility FROM memories WHERE id = 'm1'").get()).toEqual({
					agent_id: "bob",
					scope: null,
					visibility: "private",
				});
			} finally {
				db.close();
			}
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	test("rejects the retired overwrite conflict strategy", async () => {
		const root = mkdtempSync(join(tmpdir(), "signet-portable-import-conflict-"));
		try {
			const workspace = join(root, "workspace");
			const bundle = join(root, "bundle.json");
			writeFileSync(bundle, JSON.stringify({}));
			const program = new Command().exitOverride();
			registerPortableCommands(program, { AGENTS_DIR: workspace, daemonOwnsWorkspace: async () => false });
			program.configureOutput({ writeErr: () => {} });

			await expect(
				program.parseAsync(["node", "signet", "import", bundle, "--json", "--conflict", "overwrite"]),
			).rejects.toThrow();
			expect(existsSync(workspace)).toBe(false);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
