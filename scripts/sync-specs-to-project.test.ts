import { expect, test } from "bun:test";
import { graphqlArgs, graphqlString } from "./sync-specs-to-project";

test("passes GraphQL to gh without a shell", () => {
	const query = 'mutation { addProjectV2DraftIssue(input: { title: \\"$HOME; rm -rf /\\" }) { projectItem { id } } }';
	expect(graphqlArgs(query)).toEqual(["gh", "api", "graphql", "-f", `query=${query}`]);
});

test("encodes GraphQL string values completely", () => {
	const value = 'quote " slash \\\\ newline\\n tab\\t';
	expect(graphqlString(value)).toBe(JSON.stringify(value));
});
