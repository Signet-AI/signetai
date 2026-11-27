import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { ProfileFields } from "./profile-fields";

test("SSO profile fields are read-only without a save affordance", () => {
	const html = renderToStaticMarkup(
		<ProfileFields
			name="Alice"
			email="alice@example.org"
			editableFields={[]}
			ssoManaged
			busy={false}
			onNameChange={() => {}}
			onSubmit={() => {}}
		/>,
	);
	expect(html.match(/readOnly=""/g)?.length).toBe(2);
	expect(html).toContain("Managed by your identity provider");
	expect(html).not.toContain("Save profile");
});

test("password profiles offer only the fields authorized by the daemon", () => {
	const html = renderToStaticMarkup(
		<ProfileFields
			name="Alice"
			email="alice@example.org"
			editableFields={["displayName"]}
			ssoManaged={false}
			busy={false}
			onNameChange={() => {}}
			onSubmit={() => {}}
		/>,
	);
	expect(html.match(/readOnly=""/g)?.length).toBe(1);
	expect(html).toContain("Ask an administrator to change your email");
	expect(html).toContain("Save profile");
});
