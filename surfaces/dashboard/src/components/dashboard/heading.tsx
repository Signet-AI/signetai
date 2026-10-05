import type { ButtonHTMLAttributes, ReactNode } from "react";
import { ChevronRight } from "@/components/mingcute-icons";
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

export function SectionAction({ children, className, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) {
	return (
		<button type="button" className={cn("dashboard-section-action", className)} {...props}>
			{children}
			<ChevronRight className="size-3" aria-hidden="true" />
		</button>
	);
}

export type StatusTone = "ok" | "warn" | "error" | "neutral";

export function StatusLabel({
	tone,
	children,
	className,
}: {
	tone: StatusTone;
	children: ReactNode;
	className?: string;
}) {
	return (
		<span className={cn("dashboard-status", className)} data-tone={tone}>
			<span className="dashboard-status-dot" aria-hidden="true" />
			{children}
		</span>
	);
}
