import type { ReactNode } from "react";
import { cn } from "@/lib/utils";

export function PageHeading({
	title,
	description,
	id,
	level = "h1",
	className,
	children,
}: {
	title: string;
	description: ReactNode;
	id?: string;
	level?: "h1" | "h2";
	className?: string;
	children?: ReactNode;
}) {
	const Heading = level;
	return (
		<div className={cn("dashboard-page-heading", className)}>
			<div>
				<Heading id={id} className="m-0 text-foreground">
					{title}
				</Heading>
				<p className="mb-0 text-muted-foreground">{description}</p>
			</div>
			{children}
		</div>
	);
}

export function SectionHeading({
	title,
	id,
	level = "h2",
	meta,
	actions,
	className,
	titleClassName,
}: {
	title: string;
	id?: string;
	level?: "h2" | "h3";
	meta?: ReactNode;
	actions?: ReactNode;
	className?: string;
	titleClassName?: string;
}) {
	const Heading = level;
	return (
		<div className={cn("flex items-baseline gap-2.5", actions && "justify-between", className)}>
			<div className="flex flex-wrap items-baseline gap-2.5">
				<Heading id={id} className={cn("m-0 text-title font-medium tracking-tight text-foreground", titleClassName)}>
					{title}
				</Heading>
				{meta}
			</div>
			{actions}
		</div>
	);
}
