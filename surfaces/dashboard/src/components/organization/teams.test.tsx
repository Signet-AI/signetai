import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { installDashboardDomGlobals } from "@/test/dom-globals";
import { SharedKeyForm } from "./teams";

test("M3 desktop shared key controls direct users to browser or CLI", () => {
	const window = new Window({ url: "http://localhost:3860" });
	const restore = installDashboardDomGlobals(window);
	try {
		Object.defineProperty(window, "signetDesktop", { configurable: true, value: { openExternal: async () => {} } });
		const html = renderToStaticMarkup(createElement(SharedKeyForm, { agents: [], permissions: ["recall"] }));
		expect(html).toContain("Create keys from the browser dashboard or the CLI");
		expect(html).not.toContain("Issue key");
		Object.defineProperty(window, "signetDesktop", { configurable: true, value: undefined });
		expect(renderToStaticMarkup(createElement(SharedKeyForm, { agents: [], permissions: ["recall"] }))).toContain(
			"Issue key",
		);
	} finally {
		restore();
	}
});
