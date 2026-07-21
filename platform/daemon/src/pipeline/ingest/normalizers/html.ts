/**
 * HTML edge normalizer (#913 ingest unification).
 *
 * Converts HTML to a SOURCE-PRESERVING markdown form. Block structure
 * (headings, paragraphs, lists, code blocks, tables) produces real newlines so
 * each unit stays a distinct, embeddable, citable chunk. This is the deliberate
 * opposite of the legacy url-fetcher HTML path, which collapsed ALL whitespace
 * to a single line (platform/daemon/src/pipeline/url-fetcher.ts ~L191-201) and
 * destroyed structural evidence for embedding/citation/reasoning.
 *
 * `NormalizedSource.text` is the canonical form downstream layers derive from;
 * the original bytes stay immutable at the artifact layer.
 *
 * Zero external dependencies: tokenizer + tolerant tree builder + renderer are
 * hand-rolled. Node/Bun built-ins only.
 */

import { registerEdgeNormalizer, type EdgeNormalizer } from "../envelope";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type Tok =
	| { t: "text"; v: string }
	| { t: "open"; tag: string; attrs: Record<string, string>; void: boolean }
	| { t: "close"; tag: string }
	| { t: "ignore" }; // comment / doctype / processing instruction

interface ElementNode {
	type: "element";
	tag: string;
	attrs: Record<string, string>;
	children: Node[];
}
interface TextNode {
	type: "text";
	value: string;
}
type Node = ElementNode | TextNode;

/** A rendered fragment tagged block vs inline for block-aware joining. */
type Part = { text: string; block: boolean };

/** Void elements never have children and never appear on the parser stack. */
const VOID_TAGS = new Set([
	"area", "base", "br", "col", "embed", "hr", "img", "input",
	"link", "meta", "param", "source", "track", "wbr",
]);

/** Metadata / executable tags dropped entirely with their text content. */
const DROP_TAGS = new Set([
	"script", "style", "head", "title", "meta", "link",
	"noscript", "template",
]);

/** Inline elements rendered as a passthrough inline container. */
const INLINE_TAGS = new Set([
	"a", "abbr", "b", "bdi", "bdo", "cite", "code", "data", "dfn",
	"em", "i", "kbd", "mark", "q", "ruby", "s", "samp", "small",
	"span", "strong", "sub", "sup", "time", "u", "var",
]);

const block = (text: string): Part => ({ text, block: true });
const inline = (text: string): Part => ({ text, block: false });

// ---------------------------------------------------------------------------
// Entity decoding
// ---------------------------------------------------------------------------

/** The 5 core named entities required by the #913 contract, plus nbsp. */
const NAMED_ENTITIES: Record<string, string> = {
	amp: "&",
	lt: "<",
	gt: ">",
	quot: '"',
	apos: "'",
	nbsp: " ",
};

/**
 * Decode HTML entities. Single regex pass — `&amp;lt;` correctly decodes to
 * `&lt;` (not `<`) because each `&...;` span is replaced at most once. This is
 * the bug in url-fetcher's sequential `.replace` chain, avoided here.
 */
function decodeEntities(text: string): string {
	return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z][a-zA-Z0-9]*);/g, (m, body: string) => {
		if (body[0] === "#") {
			const hex = body[1] === "x";
			const code = Number.parseInt(body.slice(hex ? 2 : 1), hex ? 16 : 10);
			if (!Number.isFinite(code) || code < 0 || code > 0x10ffff) return m;
			try {
				return String.fromCodePoint(code);
			} catch {
				return m;
			}
		}
		return NAMED_ENTITIES[body] ?? m;
	});
}

/** Inline-text normalization: collapse whitespace runs to one space, decode. */
function decodeInline(text: string): string {
	return decodeEntities(text.replace(/\s+/g, " "));
}

// ---------------------------------------------------------------------------
// Tokenizer
// ---------------------------------------------------------------------------

function isLetter(ch: string | undefined): boolean {
	return !!ch && /[a-zA-Z]/.test(ch);
}

function tokenize(html: string): Tok[] {
	const toks: Tok[] = [];
	const n = html.length;
	let i = 0;

	const pushText = (v: string) => {
		if (v.length) toks.push({ t: "text", v });
	};

	while (i < n) {
		const lt = html.indexOf("<", i);
		if (lt === -1) {
			pushText(html.slice(i));
			break;
		}
		if (lt > i) pushText(html.slice(i, lt));

		// comments
		if (html.startsWith("<!--", lt)) {
			const end = html.indexOf("-->", lt + 4);
			i = end === -1 ? n : end + 3;
			toks.push({ t: "ignore" });
			continue;
		}
		// doctype / declarations / processing instructions
		if (html[lt + 1] === "!" || html[lt + 1] === "?") {
			const end = html.indexOf(">", lt);
			i = end === -1 ? n : end + 1;
			toks.push({ t: "ignore" });
			continue;
		}
		// close tag
		if (html[lt + 1] === "/") {
			const end = html.indexOf(">", lt);
			const inner = (end === -1 ? html.slice(lt + 2) : html.slice(lt + 2, end)).trim();
			const tag = (inner.split(/\s+/)[0] ?? "").toLowerCase();
			i = end === -1 ? n : end + 1;
			if (tag) toks.push({ t: "close", tag });
			continue;
		}
		// open tag — must start with a letter
		if (isLetter(html[lt + 1])) {
			const { token, next } = readOpenTag(html, lt);
			toks.push(token);
			i = next;
			continue;
		}
		// a lone '<' that is not a tag — preserve as text
		pushText("<");
		i = lt + 1;
	}
	return toks;
}

function readOpenTag(html: string, start: number): { token: Tok; next: number } {
	const n = html.length;
	let i = start + 1;
	let name = "";
	while (i < n && /[a-zA-Z0-9]/.test(html[i])) {
		name += html[i];
		i++;
	}
	const tag = name.toLowerCase();
	const attrs: Record<string, string> = {};
	let selfClosing = false;

	while (i < n) {
		while (i < n && /\s/.test(html[i])) i++;
		if (i >= n) break;
		const ch = html[i];
		if (ch === ">") {
			i++;
			break;
		}
		if (ch === "/") {
			if (html[i + 1] === ">") {
				selfClosing = true;
				i += 2;
				break;
			}
			i++;
			continue;
		}
		// attribute name
		let aname = "";
		while (i < n && !/[\s=>/]/.test(html[i])) {
			aname += html[i];
			i++;
		}
		while (i < n && /\s/.test(html[i])) i++;
		// optional value
		let aval = "";
		if (html[i] === "=") {
			i++;
			while (i < n && /\s/.test(html[i])) i++;
			const q = html[i];
			if (q === '"' || q === "'") {
				i++;
				let val = "";
				while (i < n && html[i] !== q) {
					val += html[i];
					i++;
				}
				if (i < n) i++;
				aval = val;
			} else {
				let val = "";
				while (i < n && !/[\s>]/.test(html[i])) {
					val += html[i];
					i++;
				}
				aval = val;
			}
		}
		if (aname) attrs[aname.toLowerCase()] = decodeEntities(aval);
	}

	const isVoid = selfClosing || VOID_TAGS.has(tag);
	return { token: { t: "open", tag, attrs, void: isVoid }, next: i };
}

// ---------------------------------------------------------------------------
// Tree builder (tolerant of implied end tags)
// ---------------------------------------------------------------------------

function parse(toks: Tok[]): ElementNode {
	const root: ElementNode = { type: "element", tag: "#root", attrs: {}, children: [] };
	const stack: ElementNode[] = [root];
	for (const tk of toks) {
		if (tk.t === "text") {
			last(stack).children.push({ type: "text", value: tk.v });
		} else if (tk.t === "open") {
			autoClose(stack, tk.tag);
			const el: ElementNode = { type: "element", tag: tk.tag, attrs: tk.attrs, children: [] };
			last(stack).children.push(el);
			if (!tk.void) stack.push(el);
		} else if (tk.t === "close") {
			for (let j = stack.length - 1; j >= 1; j--) {
				const s = stack[j];
				if (s.type === "element" && s.tag === tk.tag) {
					stack.length = j;
					break;
				}
			}
		}
	}
	return root;
}

function last(stack: ElementNode[]): ElementNode {
	return stack[stack.length - 1];
}

/**
 * Pop an implied-open parent when a sibling block starts. Only handles the
 * common cases (li/p/td/th/tr/thead/tbody/tfoot/dd/dt/option); well-formed
 * input never triggers it. Keeps messy real-world HTML from nesting siblings.
 */
function autoClose(stack: ElementNode[], newTag: string): void {
	const top = last(stack);
	const t = top.tag;
	switch (newTag) {
		case "li":
			if (t === "li") stack.pop();
			return;
		case "p":
			if (t === "p") stack.pop();
			return;
		case "td":
		case "th":
			if (t === "td" || t === "th") stack.pop();
			return;
		case "tr":
			if (t === "td" || t === "th" || t === "tr") stack.pop();
			return;
		case "thead":
		case "tbody":
		case "tfoot":
			if (t === "td" || t === "th" || t === "tr" || t === "thead" || t === "tbody" || t === "tfoot") stack.pop();
			return;
		case "dd":
		case "dt":
			if (t === "dd" || t === "dt") stack.pop();
			return;
		case "option":
			if (t === "option") stack.pop();
			return;
	}
}

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

function render(root: ElementNode): { text: string; title?: string } {
	const titleEl = findFirst(root, "title");
	let title: string | undefined;
	if (titleEl) {
		const t = decodeInline(textOf(titleEl)).trim();
		title = t || undefined;
	}
	const body = findFirst(root, "body") ?? root;
	const text = mergeParts(renderChildren(body.children)).trim();
	return { text: text.length ? text + "\n" : "", title };
}

function renderChildren(children: Node[]): Part[] {
	const parts: Part[] = [];
	for (const child of children) {
		const p = renderNode(child);
		if (p) parts.push(p);
	}
	return parts;
}

function renderNode(node: Node): Part | null {
	if (node.type === "text") {
		return inline(decodeInline(node.value));
	}
	const { tag, attrs, children } = node;

	if (DROP_TAGS.has(tag)) return null;

	switch (tag) {
		case "h1":
		case "h2":
		case "h3":
		case "h4":
		case "h5":
		case "h6": {
			const level = Number(tag[1]);
			return block("#".repeat(level) + " " + inlineText(children).trim());
		}
		case "p":
			return block(inlineText(children).trim());
		case "pre": {
			const raw = literalText(children).replace(/^\n/, "");
			const content = raw.endsWith("\n") ? raw.slice(0, -1) : raw;
			const fence = pickFence(content);
			return block(`${fence}\n${content}\n${fence}`);
		}
		case "ul":
		case "ol":
			return block(renderList(children, tag === "ol"));
		case "blockquote": {
			const inner = mergeParts(renderChildren(children)).trim();
			if (!inner) return null;
			return block(inner.split("\n").map((l) => (l ? "> " + l : ">")).join("\n"));
		}
		case "table":
			return block(renderTable(node));
		case "hr":
			return block("---");
		case "br":
			return inline("  \n");
		case "a": {
			const text = inlineText(children).trim();
			const href = attrs.href;
			return inline(href ? `[${text}](${href})` : text);
		}
		case "img":
			return inline(`![${attrs.alt ?? ""}](${attrs.src ?? ""})`);
		case "strong":
		case "b": {
			const text = inlineText(children).trim();
			return inline(text ? `**${text}**` : "");
		}
		case "em":
		case "i": {
			const text = inlineText(children).trim();
			return inline(text ? `*${text}*` : "");
		}
		case "code": {
			const text = decodeInline(literalText(children)).trim();
			return inline(text ? "`" + text + "`" : "");
		}
	}

	if (INLINE_TAGS.has(tag)) {
		return inline(inlineText(children));
	}

	// Generic block container (div/section/article/main/header/footer/nav/
	// aside/details/figure/figcaption, plus unknown elements). Children are
	// merged block-aware and re-emitted as one block so siblings stay separate.
	const merged = mergeParts(renderChildren(children)).trim();
	return merged ? block(merged) : null;
}

/** Render children as a single concatenated inline string (no block breaks). */
function inlineText(children: Node[]): string {
	let out = "";
	for (const p of renderChildren(children)) out += p.text;
	return out;
}

/** Raw text of all descendants: no whitespace collapse, no entity decode. */
function literalText(nodes: Node[]): string {
	let out = "";
	for (const n of nodes) {
		if (n.type === "text") out += n.value;
		else out += literalText(n.children);
	}
	return out;
}

function textOf(node: Node): string {
	if (node.type === "text") return node.value;
	let out = "";
	for (const c of node.children) out += textOf(c);
	return out;
}

function findFirst(node: Node, tag: string): ElementNode | null {
	if (node.type === "element") {
		if (node.tag === tag) return node;
		for (const c of node.children) {
			const r = findFirst(c, tag);
			if (r) return r;
		}
	}
	return null;
}

/** Fence length beats the longest backtick run in the code content. */
function pickFence(content: string): string {
	let max = 0;
	const re = /`+/g;
	let m: RegExpExecArray | null;
	while ((m = re.exec(content)) !== null) max = Math.max(max, m[0].length);
	return "`".repeat(Math.max(3, max + 1));
}

/**
 * Join rendered parts. Adjacent inline fragments concatenate into one run;
 * block fragments stay separate. All parts are joined by a blank line so
 * headings/paragraphs/lists/code/tables remain distinct structural units.
 * This is the opposite of url-fetcher's global whitespace collapse.
 */
function mergeParts(parts: Part[]): string {
	const merged: Part[] = [];
	for (const p of parts) {
		if (p.block) {
			merged.push({ text: p.text, block: true });
		} else {
			const prev = merged[merged.length - 1];
			if (prev && !prev.block) prev.text += p.text;
			else merged.push({ text: p.text, block: false });
		}
	}
	return merged
		.map((p) => p.text.replace(/^\n+|\n+$/g, ""))
		.filter((s) => s.trim().length > 0)
		.join("\n\n");
}

/**
 * Join a list item's rendered parts. Same inline-run collapsing as mergeParts,
 * but joins parts with a single "\n" so nested lists stay tight under their
 * parent item instead of being split off by a blank line.
 */
function mergeListItem(parts: Part[]): string {
	const merged: Part[] = [];
	for (const p of parts) {
		if (p.block) {
			merged.push({ text: p.text, block: true });
		} else {
			const prev = merged[merged.length - 1];
			if (prev && !prev.block) prev.text += p.text;
			else merged.push({ text: p.text, block: false });
		}
	}
	return merged
		.map((p) => p.text.replace(/^\n+|\n+$/g, ""))
		.filter((s) => s.trim().length > 0)
		.join("\n");
}

function renderList(children: Node[], ordered: boolean): string {
	const lines: string[] = [];
	let idx = 1;
	for (const c of children) {
		if (c.type !== "element" || c.tag !== "li") continue;
		const marker = ordered ? `${idx}. ` : "- ";
		idx++;
		const inner = mergeListItem(renderChildren(c.children)).trim();
		const innerLines = inner ? inner.split("\n") : [""];
		lines.push(marker + innerLines[0]);
		const pad = " ".repeat(marker.length);
		for (const ln of innerLines.slice(1)) {
			lines.push(ln ? pad + ln : ln);
		}
	}
	return lines.join("\n");
}

function renderTable(tableNode: ElementNode): string {
	const rows: { cells: string[]; header: boolean }[] = [];
	const walk = (n: ElementNode) => {
		for (const c of n.children) {
			if (c.type !== "element") continue;
			if (c.tag === "tr") {
				const cells: string[] = [];
				let header = false;
				for (const cell of c.children) {
					if (cell.type === "element" && (cell.tag === "td" || cell.tag === "th")) {
						cells.push(cellText(cell));
						if (cell.tag === "th") header = true;
					}
				}
				if (cells.length) rows.push({ cells, header });
			} else if (c.tag === "thead" || c.tag === "tbody" || c.tag === "tfoot") {
				walk(c);
			}
		}
	};
	walk(tableNode);
	if (!rows.length) return "";

	const headerRow = rows[0];
	const dataRows = rows.slice(1);
	const colCount = Math.max(1, ...rows.map((r) => r.cells.length));
	const pad = (cells: string[]) => {
		const out = cells.slice();
		while (out.length < colCount) out.push("");
		return out;
	};
	const h = pad(headerRow.cells);
	const lines: string[] = [
		`| ${h.join(" | ")} |`,
		`| ${h.map(() => "---").join(" | ")} |`,
	];
	for (const r of dataRows) {
		lines.push(`| ${pad(r.cells).join(" | ")} |`);
	}
	return lines.join("\n");
}

function cellText(cell: ElementNode): string {
	const text = inlineText(cell.children).replace(/\s+/g, " ").trim();
	return text.replace(/\|/g, "\\|");
}

// ---------------------------------------------------------------------------
// Normalizer + side-effect registration
// ---------------------------------------------------------------------------

function normalizeHtml(input: string): { text: string; title?: string } {
	const html = input.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
	const root = parse(tokenize(html));
	return render(root);
}

export const htmlNormalizer: EdgeNormalizer = {
	format: "html",
	providerGated: false,
	normalize(input, opts) {
		const { text, title } = normalizeHtml(input);
		return {
			ok: true,
			source: { format: "html", text, title, sourcePath: opts?.sourcePath },
		};
	},
};

registerEdgeNormalizer(htmlNormalizer);
