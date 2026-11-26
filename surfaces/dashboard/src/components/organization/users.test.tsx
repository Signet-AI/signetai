import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OffboardingWizard, RolesMatrix, UsersContent } from "./users";

test("people use explicit row actions and stacked mobile cards", () => {
	const html = renderToStaticMarkup(
		<UsersContent
			users={[
				{
					id: "usr_bob",
					username: "bob",
					displayName: "Bob",
					email: null,
					role: "member",
					compliance: false,
					status: "active",
				},
			]}
			refresh={() => {}}
		/>,
	);
	expect(html).not.toContain("Role for bob");
	expect(html).not.toContain("bob ·");
	expect(html).toContain("Actions for Bob");
	expect(html).toContain("sm:hidden");
	expect(html).toContain("Member");
});

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
