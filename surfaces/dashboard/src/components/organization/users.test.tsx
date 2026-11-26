import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { OffboardingImpact, RolesMatrix, UsersContent } from "./users";

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

test("offboarding preview uses plain impact labels", () => {
	const html = renderToStaticMarkup(
		<OffboardingImpact
			plan={{
				userId: "usr_bob",
				mode: "keep",
				transferTo: null,
				counts: { memories: 2, transcripts: 1, keys: 3, sessions: 4 },
			}}
		/>,
	);
	expect(html).toContain("Memories");
	expect(html).toContain("Transcripts");
	expect(html).toContain("API keys");
	expect(html).toContain("Active sessions");
	expect(html).not.toContain("userId");
});

test("roles matrix is read-only and distinguishes compliance", () => {
	const html = renderToStaticMarkup(<RolesMatrix />);
	expect(html).toContain("Compliance adds");
	expect(html).toContain("classify");
	expect(html).not.toContain("<input");
});
