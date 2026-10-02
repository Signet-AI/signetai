// Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import { CheckIcon, CopyIcon } from "lucide-react";
import { useState, memo, type ComponentProps, type HTMLAttributes } from "react";
import { Streamdown, defaultComponents } from "streamdown";
import { SourcePill, formatSourceReferences, isSourceReference, type ChatCitation } from "./source-pill";
export type MessageProps = HTMLAttributes<HTMLDivElement> & {
	from: "user" | "assistant";
};

export const Message = ({ className, from, ...props }: MessageProps) => (
	<div
		className={cn(
			"group flex w-full max-w-full flex-col gap-2",
			from === "user" ? "is-user ml-auto justify-end" : "is-assistant",
			className,
		)}
		{...props}
	/>
);

export type MessageContentProps = HTMLAttributes<HTMLDivElement>;

export const MessageContent = ({ children, className, ...props }: MessageContentProps) => (
	<div
		className={cn(
			"flex w-fit min-w-0 max-w-full flex-col gap-2 overflow-hidden text-sm",
			"group-[.is-user]:ml-auto group-[.is-user]:rounded-2xl group-[.is-user]:bg-secondary/60 group-[.is-user]:px-4 group-[.is-user]:py-3 group-[.is-user]:max-w-[92%] group-[.is-user]:text-foreground",
			"group-[.is-assistant]:text-foreground",
			className,
		)}
		{...props}
	>
		{children}
	</div>
);

export type MessageActionsProps = ComponentProps<"div">;

export const MessageActions = ({ className, children, ...props }: MessageActionsProps) => (
	<div className={cn("flex items-center gap-1", className)} {...props}>
		{children}
	</div>
);

export type MessageActionProps = ComponentProps<typeof Button> & {
	tooltip?: string;
	label?: string;
};

export const MessageAction = ({
	tooltip,
	children,
	label,
	variant = "ghost",
	size = "icon-sm",
	...props
}: MessageActionProps) => {
	const button = (
		<Button size={size} type="button" variant={variant} {...props}>
			{children}
			<span className="sr-only">{label || tooltip}</span>
		</Button>
	);

	if (tooltip) {
		return (
			<TooltipProvider>
				<Tooltip>
					<TooltipTrigger asChild>{button}</TooltipTrigger>
					<TooltipContent>
						<p>{tooltip}</p>
					</TooltipContent>
				</Tooltip>
			</TooltipProvider>
		);
	}

	return button;
};

export const MessageResponse = memo(
	({
		className,
		children,
		citations = [],
		...props
	}: ComponentProps<typeof Streamdown> & { citations?: readonly ChatCitation[] }) => (
		<Streamdown
			className={cn("size-full [&>*:first-child]:mt-0 [&>*:last-child]:mb-0", className)}
			skipHtml
			components={{
				img: () => null,
				inlineCode: ({ children, ...codeProps }) => {
					const citation =
						typeof children === "string"
							? (citations.find((item) => item.sourceRef === children && item.excerpt) ??
								citations.find((item) => item.sourceRef === children))
							: undefined;
					if (typeof children === "string" && isSourceReference(children) && citation) {
						return <SourcePill reference={children} citation={citation} />;
					}
					return <defaultComponents.code {...codeProps}>{children}</defaultComponents.code>;
				},
			}}
			{...props}
		>
			{typeof children === "string" ? formatSourceReferences(children) : children}
		</Streamdown>
	),
);
MessageResponse.displayName = "MessageResponse";

export function MessageCopyAction({ content }: { content: string }) {
	const [copied, setCopied] = useState(false);
	const [error, setError] = useState(false);
	return (
		<MessageActions>
			<MessageAction
				label={copied ? "Copied response" : "Copy response"}
				tooltip={copied ? "Copied" : "Copy response"}
				className="text-muted-foreground"
				onClick={async () => {
					try {
						await navigator.clipboard.writeText(content);
						setCopied(true);
						setError(false);
					} catch {
						setError(true);
					}
				}}
			>
				{copied ? <CheckIcon /> : <CopyIcon />}
			</MessageAction>
			{error && (
				<span role="alert" className="text-xs text-destructive">
					Could not copy. Select the text to copy it.
				</span>
			)}
		</MessageActions>
	);
}
