import { Filter, Maximize2 } from "lucide-react";
import { Surface } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

/** Header used by the Sources + Review panels: title + meta + hover tools. */
export function PanelHead({
	title,
	meta,
}: {
	title: string;
	meta?: string;
}) {
	return (
		<div className="flex items-center justify-between gap-2.5">
			<div className="flex items-baseline gap-2.5">
				<span className="text-[13px] font-semibold tracking-tight text-foreground">{title}</span>
				{meta && <span className="font-mono text-[10.5px] text-muted-foreground">{meta}</span>}
			</div>
			<div className="ml-auto flex gap-0.5 opacity-0 transition-opacity group-hover:opacity-60 group-hover:hover:opacity-100">
				<span className="grid size-5.5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
					<Filter className="size-3" />
				</span>
				<span className="grid size-5.5 place-items-center rounded text-muted-foreground hover:bg-accent hover:text-foreground">
					<Maximize2 className="size-3" />
				</span>
			</div>
		</div>
	);
}

export function Panel({
	title,
	meta,
	children,
	className,
}: {
	title: string;
	meta?: string;
	children: React.ReactNode;
	className?: string;
}) {
	return (
		<Surface className={cn("group", className)}>
			<div className="px-4 pt-3.5">{<PanelHead title={title} meta={meta} />}</div>
			<div className="px-4 pb-3.5 pt-3">{children}</div>
		</Surface>
	);
}
