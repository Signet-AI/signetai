import { expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadWorkspaceSelection, saveWorkspaceSelection } from "./workspace-selection.js";
import { dashboardStylesheet, workspaceHtml } from "./workspace-view.js";

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

test("workspace chrome reuses compiled dashboard CSS, selectable cards and tokenized controls", () => {
	expect(dashboardStylesheet('<link crossorigin rel="stylesheet" href="/assets/index-123.css">')).toBe(
		"/assets/index-123.css",
	);
	for (const index of [
		"",
		'<link rel="stylesheet" href="https://other.example/style.css">',
		'<link rel="stylesheet" href="/assets/../secret.css">',
	])
		expect(() => dashboardStylesheet(index)).toThrow();
	const html = workspaceHtml("/assets/index-123.css");
	expect(html).toContain('href="/assets/index-123.css"');
	expect(html).toContain('role="radiogroup"');
	expect(html).toContain('data-slot="card"');
	expect(html).toContain('data-variant="outline"');
	expect(html).toContain("var(--font-sans)");
	expect(html).not.toContain("<fieldset");
	expect(html).not.toContain('type="radio"');
});

test("workspace screen provides local and organization choices without secrets", () => {
	const html = workspaceHtml("/assets/index-123.css");
	expect(html).toContain("Local");
	expect(html).toContain("Organization");
	expect(html).toContain("Sign in through your browser");
	expect(html).not.toContain("localStorage");
	expect(html).not.toContain("accessToken");
	expect(html).not.toContain("refreshToken");
	expect(html).not.toContain("—");
	expect(html).toContain("<strong>Local</strong>");
	expect(html).toContain("<strong>Organization</strong>");
});
