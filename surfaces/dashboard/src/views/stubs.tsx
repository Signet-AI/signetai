import { SquareTerminal } from "lucide-react";
import { Empty, EmptyMedia, EmptyTitle, EmptyDescription } from "@/components/ui/empty";

/**
 * Thin/placeholder views matching the mockup's stub states (DASHBOARD_API_MAP
 * §2: these views are 17–61 lines in the mockup — mostly empty states). The
 * mockup is the spec; their full designs arrive in a later milestone.
 */

function Placeholder({ title, description }: { title: string; description: string }) {
	return (
		<Empty className="m-auto">
			<EmptyMedia>
				<SquareTerminal className="size-6 text-muted-foreground" />
			</EmptyMedia>
			<EmptyTitle className="text-[15px] font-semibold tracking-tight">{title}</EmptyTitle>
			<EmptyDescription className="text-[12px] text-muted-foreground">{description}</EmptyDescription>
		</Empty>
	);
}

export function GraphView() {
	return (
		<div className="relative flex flex-1 min-h-0 overflow-hidden">
			<div
				className="absolute inset-0"
				style={{ backgroundImage: "var(--sig-dotted-grid)", backgroundSize: "28px 28px" }}
			/>
			<div className="relative flex flex-1 items-center justify-center">
				<Placeholder title="Memory graph" description="The knowledge graph explorer renders here once the graph view design is finalized. The mockup stages this as an empty canvas." />
			</div>
		</div>
	);
}

export function SkillsView() {
	return (
		<div className="flex flex-1 min-h-0 items-center justify-center">
			<Placeholder title="Skills" description="Installed skills render here. The mockup stages a skill list structure." />
		</div>
	);
}

export function DreamsView() {
	return (
		<div className="flex flex-1 min-h-0 items-center justify-center">
			<Placeholder title="Dreams" description="The dreaming / cortex buffer view renders here." />
		</div>
	);
}

export function AgentsView() {
	return (
		<div className="flex flex-1 min-h-0 items-center justify-center">
			<Placeholder title="Agents" description="Agent roster and multi-tenancy controls render here." />
		</div>
	);
}
