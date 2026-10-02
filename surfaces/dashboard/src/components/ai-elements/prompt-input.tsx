// Copyright 2023 Vercel, Inc. Licensed under Apache-2.0.
// Adapted from vercel/ai-elements: dashboard imports, scoped text-only surface.
import { useState, type ComponentProps } from "react";
import { ArrowUpIcon, SquareIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function PromptInput({ className, ...props }: ComponentProps<"form">) {
	return <form className={cn("chat-prompt", className)} {...props} />;
}

export function PromptInputTextarea({
	onKeyDown,
	onCompositionStart,
	onCompositionEnd,
	className,
	...props
}: ComponentProps<"textarea">) {
	const [isComposing, setIsComposing] = useState(false);
	return (
		<textarea
			name="message"
			rows={1}
			className={cn("chat-prompt-textarea", className)}
			onCompositionStart={(event) => {
				setIsComposing(true);
				onCompositionStart?.(event);
			}}
			onCompositionEnd={(event) => {
				setIsComposing(false);
				onCompositionEnd?.(event);
			}}
			onKeyDown={(event) => {
				onKeyDown?.(event);
				if (
					event.defaultPrevented ||
					event.key !== "Enter" ||
					event.shiftKey ||
					isComposing ||
					event.nativeEvent.isComposing
				)
					return;
				event.preventDefault();
				if (event.currentTarget.form?.querySelector('button[type="submit"]:disabled')) return;
				event.currentTarget.form?.requestSubmit();
			}}
			{...props}
		/>
	);
}

export function PromptInputSubmit({
	generating,
	onStop,
	disabled,
}: {
	generating: boolean;
	onStop: () => void;
	disabled: boolean;
}) {
	return (
		<Button
			className="chat-prompt-submit"
			size="icon-sm"
			type={generating ? "button" : "submit"}
			aria-label={generating ? "Stop response" : "Send"}
			disabled={!generating && disabled}
			onClick={generating ? onStop : undefined}
		>
			{generating ? <SquareIcon className="size-3.5" /> : <ArrowUpIcon className="size-4" />}
		</Button>
	);
}
