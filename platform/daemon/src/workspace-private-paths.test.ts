import { afterAll, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exposesWorkspacePrivatePath, isWorkspacePrivatePath } from "./workspace-private-paths";

const home = mkdtempSync(join(tmpdir(), "signet-private-paths-"));
const workspace = join(home, ".agents");
mkdirSync(join(workspace, ".daemon"), { recursive: true });
mkdirSync(join(workspace, "memory"), { recursive: true });
mkdirSync(join(home, "notes"), { recursive: true });
writeFileSync(join(workspace, ".daemon", "auth-secret"), "secret");

afterAll(() => {
	rmSync(home, { recursive: true, force: true });
});

describe("workspace private paths", () => {
	it("allows a parent folder only for walkers that skip hidden paths", () => {
		expect(exposesWorkspacePrivatePath(home, workspace, { skipsHiddenPaths: true })).toBe(false);
		expect(exposesWorkspacePrivatePath(home, workspace, { skipsHiddenPaths: false })).toBe(true);
	});

	it("refuses roots inside or equal to private directories in either mode", () => {
		for (const skipsHiddenPaths of [true, false]) {
			expect(exposesWorkspacePrivatePath(join(workspace, ".daemon"), workspace, { skipsHiddenPaths })).toBe(true);
			expect(exposesWorkspacePrivatePath(join(workspace, "memory"), workspace, { skipsHiddenPaths })).toBe(true);
			expect(exposesWorkspacePrivatePath(workspace, workspace, { skipsHiddenPaths })).toBe(true);
			expect(exposesWorkspacePrivatePath(join(home, "notes"), workspace, { skipsHiddenPaths })).toBe(false);
		}
	});

	it("matches files by resolved path", () => {
		expect(isWorkspacePrivatePath(join(workspace, ".daemon", "auth-secret"), workspace)).toBe(true);
		expect(isWorkspacePrivatePath(join(workspace, "memory", "..", ".daemon", "auth-secret"), workspace)).toBe(true);
		expect(isWorkspacePrivatePath(join(home, "notes", "a.md"), workspace)).toBe(false);
	});
});
