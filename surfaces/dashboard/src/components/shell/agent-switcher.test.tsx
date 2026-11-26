import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentContextSelect } from "./agent-switcher";

test("agent context uses the existing source-filter Select trigger", () => {
	const html = renderToStaticMarkup(
		<AgentContextSelect
			value="default"
			disabled={false}
			groups={[
				{ label: "Organization", agents: [{ id: "default", name: "Acme" }] },
				{ label: "Teams", agents: [] },
				{ label: "Personal", agents: [] },
			]}
			onValueChange={() => {}}
		/>,
	);
	expect(html).toContain('data-slot="select-trigger"');
	expect(html).toContain("home-source-filter");
	expect(html).toContain('aria-label="Agent context"');
	expect(html).not.toContain("(default)");
});
