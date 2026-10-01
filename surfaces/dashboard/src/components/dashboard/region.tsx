import type { ReactNode, Ref } from "react";
import { SectionHeading } from "./heading";
import { cn } from "@/lib/utils";

export function DashboardRegion({
	title,
	meta,
	actions,
	className,
	headerClassName,
	bodyRef,
	children,
	footer,
}: {
	title: string;
	meta?: ReactNode;
	actions?: ReactNode;
	className?: string;
	headerClassName?: string;
	bodyRef?: Ref<HTMLDivElement>;
	children: ReactNode;
	footer?: ReactNode;
}) {
	return (
		<section className={cn("dashboard-region", className)}>
			<SectionHeading
				title={title}
				meta={meta}
				actions={actions}
				titleClassName="font-medium tracking-normal"
				className={headerClassName}
			/>
			<div ref={bodyRef} className="dashboard-region-body">
				{children}
			</div>
			{footer}
		</section>
	);
}
