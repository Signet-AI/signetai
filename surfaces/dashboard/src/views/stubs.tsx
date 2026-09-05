import { SquareTerminal } from "@/components/mingcute-icons";
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

export function SkillsView() {
	return (
		<div className="flex flex-1 min-h-0 items-center justify-center">
			<Placeholder
				title="Skills"
				description="Installed skills render here. The mockup stages a skill list structure."
			/>
		</div>
	);
}
