import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { validateExternalUrl } from "./external-url";

describe("desktop OAuth external navigation", () => {
	test("accepts HTTPS authorization URLs and rejects other schemes", () => {
		expect(validateExternalUrl("https://auth.openai.com/oauth/authorize?client_id=test")).toBe(
			"https://auth.openai.com/oauth/authorize?client_id=test",
		);
		expect(() => validateExternalUrl("http://auth.openai.com/oauth/authorize")).toThrow("Only HTTPS URLs");
		expect(() => validateExternalUrl("javascript:alert(1)")).toThrow();
	});

	test("wires the OAuth bridge before browser-popup fallback", () => {
		const mainSource = readFileSync(join(import.meta.dir, "main.ts"), "utf8");
		const preloadSource = readFileSync(join(import.meta.dir, "preload.cts"), "utf8");
		const dialogSource = readFileSync(
			join(import.meta.dir, "../../dashboard/src/components/settings/connect-dialog.tsx"),
			"utf8",
		);
		const openWindow = dialogSource.slice(
			dialogSource.indexOf("const openOAuthWindow"),
			dialogSource.indexOf("const navigateOAuthWindow"),
		);

		expect(mainSource).toContain('ipcMain.handle("desktop:openExternal"');
		expect(preloadSource).toContain('ipcRenderer.invoke("desktop:openExternal", url)');
		expect(openWindow.indexOf("getDesktopBridge()")).toBeLessThan(openWindow.indexOf('window.open("about:blank"'));
	});
});
