import type { ComponentProps } from "react";
import { DropdownMenu as Primitive } from "radix-ui";
import { cn } from "@/lib/utils";

export const DropdownMenu = Primitive.Root;
export const DropdownMenuTrigger = Primitive.Trigger;
export const DropdownMenuLabel = Primitive.Label;

export function DropdownMenuContent({ className, sideOffset = 4, ...props }: ComponentProps<typeof Primitive.Content>) {
	return (
		<Primitive.Portal>
			<Primitive.Content
				data-slot="dropdown-menu-content"
				sideOffset={sideOffset}
				className={cn(
					"z-50 min-w-32 overflow-hidden rounded-[var(--control-radius)] border border-border bg-popover p-1 font-sans text-popover-foreground shadow-md",
					className,
				)}
				{...props}
			/>
		</Primitive.Portal>
	);
}

export function DropdownMenuItem({
	className,
	variant = "default",
	...props
}: ComponentProps<typeof Primitive.Item> & { readonly variant?: "default" | "destructive" }) {
	return (
		<Primitive.Item
			data-slot="dropdown-menu-item"
			data-variant={variant}
			className={cn(
				"relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50",
				variant === "destructive" && "text-destructive focus:bg-destructive/10 focus:text-destructive",
				className,
			)}
			{...props}
		/>
	);
}

export function DropdownMenuSeparator({ className, ...props }: ComponentProps<typeof Primitive.Separator>) {
	return (
		<Primitive.Separator
			data-slot="dropdown-menu-separator"
			className={cn("-mx-1 my-1 h-px bg-border", className)}
			{...props}
		/>
	);
}
