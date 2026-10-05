import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Command } from "commander";
import { registerPortableCommands } from "./portable";

async function runImport(workspace: string, bundle: string): Promise<void> {
	const program = new Command();
	registerPortableCommands(program, { AGENTS_DIR: workspace });
	await program.parseAsync(["node", "signet", "import", bundle, "--json"]);
}

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
});
