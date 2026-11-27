import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamContent, TeamDirectory } from "./teams";

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
