import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TeamDirectory } from "./teams";

test("empty Teams directory explains the team-owner path without hidden counts", () => {
	const html = renderToStaticMarkup(<TeamDirectory groups={[]} onSelect={() => {}} />);
	expect(html).toContain("Create a team, add members, then create a team agent");
	expect(html).toContain("organization administrator");
	expect(html).not.toContain("<table");
	expect(html).not.toContain("hidden");
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
