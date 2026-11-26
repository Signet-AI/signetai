import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OffboardingWizard, RolesMatrix } from "./users";

test("offboarding starts with preview, not a destructive submit", () => {
	const html = renderToStaticMarkup(
		<OffboardingWizard
			user={{
				id: "usr_bob",
				username: "bob",
				displayName: "Bob",
				email: null,
				role: "member",
				compliance: false,
				status: "active",
			}}
			users={[]}
			onClose={() => {}}
		/>,
	);
	expect(html).toContain("Preview offboarding");
	expect(html).not.toContain("Confirm offboarding");
	expect(html).toContain("Authorship is preserved");
});

test("roles matrix is read-only and distinguishes compliance", () => {
	const html = renderToStaticMarkup(<RolesMatrix />);
	expect(html).toContain("Compliance adds");
	expect(html).toContain("classify");
	expect(html).not.toContain("<input");
});
