import { afterAll, beforeAll, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { installDashboardDomGlobals } from "@/test/dom-globals";
import { FilterToolbar } from "./filters";
import { Choice } from "./controls";
let restore = () => {};
beforeAll(() => {
	restore = installDashboardDomGlobals(new Window());
});
afterAll(() => restore());
test("list filters provide an inline desktop toolbar and one mobile sheet trigger", () => {
	const element = document.createElement("div");
	element.innerHTML = renderToStaticMarkup(
		<FilterToolbar>
			<Choice inline label="Team" value="" onChange={() => {}} options={[{ value: "", label: "All teams" }]} />
		</FilterToolbar>,
	);
	expect(element.querySelector('[role="toolbar"]')?.className).toContain("sm:flex");
	expect([...element.querySelectorAll("button")].filter((button) => button.textContent === "Filters")).toHaveLength(1);
	expect(element.querySelector(".settings-row")).toBeNull();
});
