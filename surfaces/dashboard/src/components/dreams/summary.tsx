import type { ReactNode } from "react";
export function MarkdownSummary({ text }: { text: string }) {
	const blocks = splitMarkdownBlocks(text);
	return (
		<div className="dreams-summary-copy">
			{blocks.map((block) => {
				if (block.type === "heading") {
					const Tag = block.level === 1 ? "h3" : block.level === 2 ? "h4" : "h5";
					return (
						<Tag key={block.id} className="dreams-md-heading">
							{renderInline(block.text, block.id)}
						</Tag>
					);
				}
				if (block.type === "list") {
					return (
						<ul key={block.id} className="dreams-md-list">
							{block.items?.map((item) => (
								<li key={item.id}>{renderInline(item.text, item.id)}</li>
							))}
						</ul>
					);
				}
				return (
					<p key={block.id} className="dreams-md-para">
						{renderInline(block.text, block.id)}
					</p>
				);
			})}
		</div>
	);
}

const INLINE_MD_RE = /(\*\*[^*]+\*\*|\*[^*]+\*|`[^`]+`|\[[^\]]+\]\([^)]+\))/g;

function renderInline(text: string, keyBase: string): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let n = 0;
	for (let m = INLINE_MD_RE.exec(text); m; m = INLINE_MD_RE.exec(text)) {
		if (m.index > last) out.push(...renderTinted(text.slice(last, m.index), `${keyBase}t${n}`));
		const tok = m[0];
		if (tok.startsWith("**")) {
			out.push(
				<strong key={`${keyBase}b${n}`} className="dreams-md-strong">
					{tok.slice(2, -2)}
				</strong>,
			);
		} else if (tok.startsWith("`")) {
			out.push(
				<code key={`${keyBase}c${n}`} className="dreams-md-code">
					{tok.slice(1, -1)}
				</code>,
			);
		} else if (tok.startsWith("[")) {
			const link = /^\[([^\]]+)\]\(([^)]+)\)$/.exec(tok);
			if (link) {
				out.push(
					<a
						key={`${keyBase}a${n}`}
						href={link[2]}
						target="_blank"
						rel="noreferrer"
						className="text-foreground underline underline-offset-2"
					>
						{link[1]}
					</a>,
				);
			} else {
				out.push(<span key={`${keyBase}a${n}`}>{tok}</span>);
			}
		} else {
			out.push(
				<em key={`${keyBase}e${n}`} className="italic">
					{tok.slice(1, -1)}
				</em>,
			);
		}
		last = m.index + tok.length;
		n += 1;
	}
	if (last < text.length) out.push(...renderTinted(text.slice(last), `${keyBase}t${n}`));
	return out;
}
function renderTinted(text: string, keyBase: string): ReactNode[] {
	const out: ReactNode[] = [];
	let last = 0;
	let n = 0;
	for (let m = SUMMARY_TOKEN_RE.exec(text); m; m = SUMMARY_TOKEN_RE.exec(text)) {
		if (m.index > last) out.push(<span key={`${keyBase}x${n}`}>{text.slice(last, m.index)}</span>);
		const token = m[0];
		const looksLikeId = /^[0-9a-f]/.test(token) || /^(entity|aspect|attention):/.test(token);
		out.push(
			looksLikeId ? (
				<span key={`${keyBase}i${n}`} className="dreams-md-code">
					{token}
				</span>
			) : (
				<span key={`${keyBase}e${n}`} className="dreams-md-strong">
					{token}
				</span>
			),
		);
		last = m.index + token.length;
		n += 1;
	}
	if (last < text.length) out.push(<span key={`${keyBase}x${n}`}>{text.slice(last)}</span>);
	return out;
}

const SUMMARY_TOKEN_RE =
	/(\b(?:entity|aspect|attention):[0-9a-f]{8}\b|[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}\b|\b[0-9a-f]{8}\b|non-functional|non functional|failed|failure|unresolved|unaddressable|deferred indefinitely|not found|error)/gi;

function splitMarkdownBlocks(text: string): ReadonlyArray<{
	id: string;
	type: "heading" | "list" | "para";
	level?: number;
	text: string;
	items?: Array<{ id: string; text: string }>;
}> {
	const blocks: Array<{
		id: string;
		type: "heading" | "list" | "para";
		level?: number;
		text: string;
		items?: Array<{ id: string; text: string }>;
	}> = [];
	let para: string[] = [];
	let listItems: Array<{ id: string; text: string }> | null = null;
	let seq = 0;
	const nextId = () => `b${seq++}`;
	const flushPara = () => {
		if (para.length) {
			blocks.push({ id: nextId(), type: "para", text: para.join("\n") });
			para = [];
		}
	};
	const flushList = () => {
		if (listItems) {
			blocks.push({ id: nextId(), type: "list", text: "", items: listItems });
			listItems = null;
		}
	};
	for (const line of text.split("\n")) {
		const heading = /^(#{1,3})\s+(.*)$/.exec(line);
		const bullet = /^[-*]\s+(.*)$/.exec(line);
		const ordered = /^\d+\.\s+(.*)$/.exec(line);
		if (heading) {
			flushPara();
			flushList();
			blocks.push({ id: nextId(), type: "heading", level: heading[1].length, text: heading[2] });
		} else if (bullet || ordered) {
			flushPara();
			if (!listItems) listItems = [];
			listItems.push({ id: nextId(), text: (bullet ?? ordered)?.[1] ?? "" });
		} else if (line.trim() === "") {
			flushPara();
			flushList();
		} else {
			flushList();
			para.push(line);
		}
	}
	flushPara();
	flushList();
	return blocks;
}
export function markdownSummaryPreview(text: string): string {
	const content = splitMarkdownBlocks(text)
		.map((block) => (block.type === "list" ? (block.items ?? []).map((item) => item.text).join(" · ") : block.text))
		.join(" ");
	return content
		.replace(/\*\*([^*]+)\*\*/g, "$1")
		.replace(/\*([^*]+)\*/g, "$1")
		.replace(/`([^`]+)`/g, "$1")
		.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
		.replace(/\s+/g, " ")
		.trim();
}
