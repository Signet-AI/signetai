import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installDashboardDomGlobals } from "./dom-globals";

test("replaces an incomplete browser global and restores previous descriptors", () => {
	const originalWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
	const staleWindow = {};
	Object.defineProperty(globalThis, "window", {
		configurable: true,
		enumerable: true,
		writable: true,
		value: staleWindow,
	});
	const dom = new Window({ url: "http://localhost/#setup" });
	const restore = installDashboardDomGlobals(dom);
	const globals = globalThis as typeof globalThis & { window: Window; document: Document };
	try {
		expect(globals.window).toBe(dom);
		expect(globals.document).toBe(dom.document);
		expect(globals.window.location.hash).toBe("#setup");
		expect(globals.window.getComputedStyle).toBeTypeOf("function");
		restore();
		expect(Reflect.get(globalThis, "window")).toBe(staleWindow);
	} finally {
		restore();
		dom.close();
		if (originalWindow) Object.defineProperty(globalThis, "window", originalWindow);
		else Reflect.deleteProperty(globalThis, "window");
	}
});
