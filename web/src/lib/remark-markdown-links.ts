import type { Link, Root } from "mdast";
import type { Plugin } from "unified";
import { visit } from "unist-util-visit";
import { rewriteMarkdownHref } from "./content-routes";

const remarkMarkdownLinks: Plugin<[], Root> = () => {
	return (tree, file) => {
		visit(tree, "link", (node: Link) => {
			const nextUrl = rewriteMarkdownHref(node.url, file.path);
			if (nextUrl) node.url = nextUrl;
		});
	};
};

export default remarkMarkdownLinks;
