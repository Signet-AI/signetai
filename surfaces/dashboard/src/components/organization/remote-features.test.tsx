import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { RemoteHostFeaturesContent } from "./remote-features";

test("host feature policy is readable but has no dashboard mutation controls", () => {
	const html = renderToStaticMarkup(
		<RemoteHostFeaturesContent
			features={[
				{ name: "git.sync", allowed: true },
				{ name: "plugins.manage", allowed: false },
			]}
		/>,
	);
	expect(html).toContain("git.sync");
	expect(html).toContain("Allowed remotely");
	expect(html).toContain("plugins.manage");
	expect(html).toContain("Server only");
	expect(html).toContain("Changed on the server");
	expect(html).not.toMatch(/<(button|input|form|select)\b/);
});
