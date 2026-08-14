import { describe, expect, test } from "bun:test";
import { bindTrayInteractions, type TrayInteractionHost } from "./tray-interactions";

interface FakeMenu {
	readonly name: string;
}

interface FakeTray extends TrayInteractionHost<FakeMenu> {
	readonly listeners: Partial<Record<"click" | "right-click", () => void>>;
	readonly poppedMenus: FakeMenu[];
}

function fakeTray(): FakeTray {
	const listeners: FakeTray["listeners"] = {};
	const poppedMenus: FakeMenu[] = [];
	return {
		listeners,
		poppedMenus,
		on: (event, listener) => {
			listeners[event] = listener;
		},
		popUpContextMenu: (menu) => {
			poppedMenus.push(menu);
		},
	};
}

describe("desktop tray interactions", () => {
	test("opens the dashboard on macOS left-click and keeps the menu on right-click", () => {
		const tray = fakeTray();
		const menu = { name: "current" };
		let openCalls = 0;

		bindTrayInteractions(
			tray,
			() => {
				openCalls += 1;
			},
			() => menu,
			"darwin",
		);

		tray.listeners.click?.();
		tray.listeners["right-click"]?.();

		expect(openCalls).toBe(1);
		expect(tray.poppedMenus).toEqual([menu]);
	});

	test("does not install macOS right-click handling on other platforms", () => {
		const tray = fakeTray();

		bindTrayInteractions(
			tray,
			() => undefined,
			() => ({ name: "current" }),
			"linux",
		);

		expect(tray.listeners.click).toBeFunction();
		expect(tray.listeners["right-click"]).toBeUndefined();
	});
});
