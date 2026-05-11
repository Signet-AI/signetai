import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildContentIndex } from "../../web/marketing/src/lib/content-graph";

const rootDir = fileURLToPath(new URL("../../", import.meta.url));

function readCommittedContentIndex(): unknown {
	return JSON.parse(readFileSync(join(rootDir, "web/marketing/public/contentIndex.json"), "utf8"));
}

describe("web content graph regression guard", () => {
	it("keeps the committed content index aligned with docs and blog sources", () => {
		expect(readCommittedContentIndex()).toEqual(
			buildContentIndex(join(rootDir, "docs"), join(rootDir, "web/marketing/src/content/blog")),
		);
	});
});
