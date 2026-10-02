import { Popover } from "radix-ui";
import { BookOpenIcon } from "lucide-react";

export interface ChatCitation {
	readonly sourceRef: string;
	readonly excerpt: string;
}

export function isSourceReference(value: string): boolean {
	return /^(?:artifact|memory|source|transcript|summary):[^\r\n`[\]|]+$/.test(value);
}

export function sourceLabel(reference: string): string {
	if (reference.startsWith("artifact:")) return reference.split("/").at(-1) || "Source document";
	if (reference.startsWith("memory:")) return "Memory";
	if (reference.startsWith("transcript:")) return "Transcript";
	if (reference.startsWith("summary:")) return "Summary";
	return "Source";
}

export function formatSourceReferences(markdown: string): string {
	return markdown
		.split(/(```[\s\S]*?(?:```|$)|~~~[\s\S]*?(?:~~~|$))/g)
		.map((part, index) => {
			if (index % 2) return part;
			return part
				.replace(/\[\[([^\]\r\n]+)\]\]/g, (original, reference: string) =>
					isSourceReference(reference) ? `\`${reference}\`` : original,
				)
				.replace(
					/[[(](?:Source:\s*)?\s*`?((?:artifact|memory|source|transcript|summary):[^\s`\])]+)`?\s*[\])]/gi,
					(original, reference: string) => (isSourceReference(reference) ? `\`${reference}\`` : original),
				);
		})
		.join("");
}

export function SourcePill({ reference, citation }: { reference: string; citation?: ChatCitation }) {
	const label = sourceLabel(reference);
	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<button type="button" className="chat-source-pill" aria-label={`View source: ${label}`}>
					<BookOpenIcon aria-hidden="true" size={12} />
					<span>{label}</span>
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content sideOffset={8} align="start" className="chat-source-preview">
					<h3>{label}</h3>
					{citation?.excerpt && <p>{citation.excerpt}</p>}
					<details>
						<summary>Source reference</summary>
						<code>{reference}</code>
					</details>
					<Popover.Arrow className="fill-border" />
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}
