import { describe, expect, it } from "bun:test";
import { buildBlogSearchItems } from "./search-index";

describe("buildBlogSearchItems", () => {
	it("builds an empty excerpt when the content body is absent", () => {
		const post = {
			id: "empty-post",
			collection: "blog",
			data: {
				title: "Example",
				description: "Example description",
				date: new Date("2026-01-01T00:00:00Z"),
				author: "Nicholai",
				tags: [],
				draft: false,
			},
		} satisfies Parameters<typeof buildBlogSearchItems>[0];

		const [item] = buildBlogSearchItems(post);

		expect(item?.excerpt).toBe("");
	});
});
