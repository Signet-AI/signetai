// Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
import { Collapsible } from "radix-ui";
import { cn } from "@/lib/utils";
import { ChevronDownIcon } from "lucide-react";
import type { ComponentProps } from "react";
export type SourcesProps = ComponentProps<"div">;

export const Sources = ({ className, ...props }: SourcesProps) => (
	<Collapsible.Root className={cn("not-prose text-muted-foreground text-xs", className)} {...props} />
);

export type SourcesTriggerProps = ComponentProps<typeof Collapsible.Trigger> & {
	count: number;
};

export const SourcesTrigger = ({ className, count, children, ...props }: SourcesTriggerProps) => (
	<Collapsible.Trigger className={cn("group/sources chat-sources-trigger", className)} {...props}>
		{children ?? (
			<>
				<p>
					{count} {count === 1 ? "source" : "sources"}
				</p>
				<ChevronDownIcon className="size-3.5 transition-transform group-data-[state=open]/sources:rotate-180" />
			</>
		)}
	</Collapsible.Trigger>
);

export type SourcesContentProps = ComponentProps<typeof Collapsible.Content>;

export const SourcesContent = ({ className, ...props }: SourcesContentProps) => (
	<Collapsible.Content
		className={cn(
			"mt-3 flex w-fit flex-col gap-2",
			"data-[state=closed]:fade-out-0 data-[state=closed]:slide-out-to-top-2 data-[state=open]:slide-in-from-top-2 outline-none data-[state=closed]:animate-out data-[state=open]:animate-in",
			className,
		)}
		{...props}
	/>
);
