import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadWorkspaceSelection, saveWorkspaceSelection } from "./workspace-selection.js";
import { workspaceHtml } from "./workspace-view.js";

test("workspace choice persists only mode and origin and corruption fails closed", async () => {
	const root = await mkdtemp(join(tmpdir(), "desktop-selection-"));
	const file = join(root, "selection.json");
	try {
		expect(await loadWorkspaceSelection(file)).toEqual({ mode: "local" });
		await saveWorkspaceSelection(file, { mode: "organization", origin: "https://org.example" });
		expect(await loadWorkspaceSelection(file)).toEqual({ mode: "organization", origin: "https://org.example" });
		expect(await readFile(file, "utf8")).not.toContain("Token");
		await writeFile(file, "broken");
		await expect(loadWorkspaceSelection(file)).rejects.toThrow();
	} finally {
		await rm(root, { recursive: true, force: true });
	}
});

test("workspace screen provides local and organization choices without secrets", () => {
	const html = workspaceHtml();
	expect(html).toContain("Local");
	expect(html).toContain("Organization");
	expect(html).toContain("Sign in through your browser");
	expect(html).not.toContain("localStorage");
	expect(html).not.toContain("accessToken");
	expect(html).not.toContain("refreshToken");
});
