import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { AgentContextSelect, contextAgentDisplayName } from "./agent-switcher";

test("organization context presents its display name, never the structural default id", () => {
	expect(contextAgentDisplayName({ name: "default", kind: "organization" }, "Acme")).toBe("Acme");
	expect(contextAgentDisplayName({ name: "Shared knowledge", kind: "organization" }, "Acme")).toBe("Shared knowledge");
	expect(contextAgentDisplayName({ name: "default", kind: "personal" }, "Acme")).toBe("default");
});

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
	expect(html).toContain('title="Acme"');
	expect(html).toContain('aria-hidden="true" class="sm:hidden">A</span>');
	expect(html).toContain("max-sm:size-9");
	expect(html).toContain("max-sm:[&amp;&gt;[data-slot=select-value]]:hidden");
});
