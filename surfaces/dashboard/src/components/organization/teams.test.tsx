import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Window } from "happy-dom";
import { installDashboardDomGlobals } from "@/test/dom-globals";
import { SharedKeyForm, TeamContent, TeamDirectory } from "./teams";

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

test("empty Teams directory explains the team-owner path without hidden counts", () => {
	const html = renderToStaticMarkup(<TeamDirectory groups={[]} onSelect={() => {}} />);
	expect(html).toContain("Create a team, add members, then create a team agent");
	expect(html).toContain("organization administrator");
	expect(html).not.toContain("<table");
	expect(html).not.toContain("hidden");
});

test("team owners can create a team agent while ordinary members cannot", () => {
	const group = { id: "eng", name: "Engineering", description: null, managed_by: "signet" as const, members: [] };
	const render = (canManage: boolean) =>
		renderToStaticMarkup(
			<TeamContent
				group={group}
				agents={[]}
				classifications={[]}
				canManage={canManage}
				admin={false}
				permissions={["remember", "recall"]}
				refresh={() => {}}
			/>,
		);
	expect(render(true)).toContain("Create team agent");
	expect(render(true)).toContain("Team agent name");
	expect(render(false)).not.toContain("Create team agent");
});

test("populated Teams directory keeps its existing list", () => {
	const html = renderToStaticMarkup(
		<TeamDirectory
			groups={[{ id: "eng", name: "Engineering", description: "Product development", managed_by: "signet" }]}
			onSelect={() => {}}
		/>,
	);
	expect(html).toContain("Engineering");
	expect(html).toContain("<table");
	expect(html).not.toContain("Create a team, add members");
});
