import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { renderToStaticMarkup } from "react-dom/server";
import { SharedKeyForm } from "./teams";
import { AccessContent, OffboardingImpact, RolesMatrix, UsersContent } from "./users";

test("shared-key permission labels are human-readable", () => {
	const html = renderToStaticMarkup(<SharedKeyForm agents={[]} permissions={["remember", "recall"]} />);
	expect(html).toContain("Remember</label>");
	expect(html).toContain("Recall</label>");
});

test("effective access uses named mobile cards and an explicit classifications empty state", () => {
	const html = renderToStaticMarkup(
		<AccessContent
			access={{
				user: {
					id: "usr_alice",
					username: "alice",
					displayName: "Alice",
					email: null,
					role: "member",
					compliance: false,
					status: "active",
				},
				role: "member",
				permissions: ["recall"],
				groups: ["grp_eng"],
				actAs: [
					{ agentId: "agent_eng", kind: "team", why: "group membership" },
					{ agentId: "default", kind: "organization", why: "active user" },
					{ agentId: "personal", kind: "personal", why: "personal owner" },
					{ agentId: "admin-team", kind: "team", why: "administrator" },
				],
				readableClassifications: [],
			}}
			groups={[{ id: "grp_eng", name: "Engineering", description: null, managed_by: "signet" }]}
			agents={[
				{
					id: "agent_eng",
					name: "Engineering assistant",
					kind: "team",
					ownerUserId: null,
					ownerGroupId: "grp_eng",
					archivedAt: null,
					canActAs: true,
				},
			]}
		/>,
	);
	expect(html).toContain("Engineering assistant");
	expect(html).toContain("Teams: Engineering");
	expect(html).toContain("Member of team Engineering");
	expect(html).toContain("Every active user can act as the organization agent");
	expect(html).toContain("Owns this personal agent");
	expect(html).toContain("Administrator");
	expect(html).not.toContain("transferred from");
	expect(html).toContain("sm:hidden");
	expect(html).toContain("No readable classifications.");
});

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

test("matching handles do not duplicate the user's name in either layout", () => {
	for (const email of [null, "bob@example.com"]) {
		const dom = new Window();
		dom.document.body.innerHTML = renderToStaticMarkup(
			<UsersContent
				users={[
					{
						id: "usr_bob",
						username: "bob",
						displayName: "bob",
						email,
						role: "member",
						compliance: false,
						status: "active",
					},
				]}
				refresh={() => {}}
			/>,
		);
		expect(dom.document.querySelector("tbody tr td")?.textContent).toBe(`bob${email ?? ""}`);
		expect(dom.document.querySelector("ul li p:nth-child(2)")?.textContent ?? null).toBe(email);
	}
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
