import { describe, expect, test } from "bun:test";
import { applicationMenuTemplate } from "./application-menu";

describe("desktop application menu", () => {
	test("keeps the native macOS app, edit, and window menus", () => {
		expect(applicationMenuTemplate("darwin")).toEqual([
			{ role: "appMenu" },
			{ role: "editMenu" },
			{ role: "windowMenu" },
		]);
	});

	test("removes the application menu only on non-macOS platforms", () => {
		expect(applicationMenuTemplate("linux")).toBeNull();
		expect(applicationMenuTemplate("win32")).toBeNull();
	});
});
