import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ClassificationBadges } from "./attribution";
import { Panel, panelState } from "./panel";

test("panels distinguish all five non-ready states", () => {
	expect(panelState(null, false)).toBe("loading");
	expect(panelState({ data: [], error: null }, true)).toBe("empty");
	expect(panelState({ data: null, error: "Expired", status: 401 }, false)).toBe("signed-out");
	expect(panelState({ data: null, error: "Requires the operator role", status: 403 }, false)).toBe("forbidden");
	expect(panelState({ data: null, error: "Offline", status: 0 }, false)).toBe("degraded");
	expect(panelState({ data: [1], error: null }, false)).toBe("ready");
	const html = renderToStaticMarkup(
		<Panel result={{ data: null, error: "Requires the operator role", status: 403 }}>{() => "secret"}</Panel>,
	);
	expect(html).toContain("Requires the operator role");
	expect(html).not.toContain("secret");
});

test("non-audience classification badges leave no markup or hidden count", () => {
	const classifications = [{ id: "cls_hr", name: "HR" }];
	expect(renderToStaticMarkup(<ClassificationBadges classifications={classifications} audienceIds={new Set()} />)).toBe(
		"",
	);
	expect(
		renderToStaticMarkup(<ClassificationBadges classifications={classifications} audienceIds={new Set(["cls_hr"])} />),
	).toContain("HR");
});
