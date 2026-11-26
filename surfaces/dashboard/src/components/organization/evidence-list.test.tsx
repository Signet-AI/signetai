import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { EvidenceList } from "./evidence-list";
test("unavailable author names are placeholders, not styled like a person's name", () => {
	const dom = new Window();
	dom.document.body.innerHTML = renderToStaticMarkup(
		<EvidenceList
			rows={[
				{
					key: "unknown",
					title: "Unknown author item",
					kind: "memory",
					agent: "Engineering",
					author: "Another person",
					authorUnavailable: true,
				},
				{ key: "known", title: "Known author item", kind: "memory", agent: "Engineering", author: "Another person" },
			]}
		/>,
	);
	const cells = dom.document.querySelectorAll("tbody tr td:nth-child(3)");
	expect(cells[0]?.querySelector("span")?.className).toContain("italic");
	expect(cells[0]?.querySelector("span")?.className).toContain("text-muted-foreground");
	expect(cells[1]?.querySelector("span")).toBeNull();
	expect(dom.document.querySelectorAll("ul .italic")).toHaveLength(1);
});
