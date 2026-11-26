import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { TopbarTitle, UpdateAvailability } from "./topbar";

test("organization page titles use the local centered position at every breakpoint", () => {
	const html = renderToStaticMarkup(<TopbarTitle label="Home" organization />);
	expect(html).toContain("left-1/2");
	expect(html).toContain("-translate-x-1/2");
	expect(html).not.toContain("hidden sm:flex");
});

test("only organization administrators see unavailable instance updates", () => {
	expect(renderToStaticMarkup(<UpdateAvailability count={1} organizationRole="member" />)).toBe("");
	expect(renderToStaticMarkup(<UpdateAvailability count={1} organizationRole="admin" />)).toContain(
		"Updates unavailable",
	);
	expect(renderToStaticMarkup(<UpdateAvailability count={1} />)).toContain("Updates unavailable");
	expect(renderToStaticMarkup(<UpdateAvailability count={0} organizationRole="admin" />)).toBe("");
});
