import { Badge } from "@/components/ui/badge";

export function Attribution({ author, agent }: { readonly author: string | null; readonly agent: string | null }) {
	if (!author && !agent) return null;
	return <span className="text-xs text-muted-foreground">{[author, agent].filter(Boolean).join(" · ")}</span>;
}

export interface ClassificationLabel {
	readonly id: string;
	readonly name: string;
}

export function ClassificationBadges({
	classifications,
	audienceIds,
}: {
	readonly classifications: readonly ClassificationLabel[];
	readonly audienceIds: ReadonlySet<string>;
}) {
	return (
		<>
			{classifications
				.filter((classification) => audienceIds.has(classification.id))
				.map((classification) => (
					<Badge key={classification.id}>{classification.name}</Badge>
				))}
		</>
	);
}
