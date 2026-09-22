import * as React from "react";
import { Switch as SwitchPrimitive } from "radix-ui";

import { cn } from "@/lib/utils";
function Switch({ className, ...props }: React.ComponentProps<typeof SwitchPrimitive.Root>) {
	return (
		<SwitchPrimitive.Root
			data-slot="switch"
			className={cn(
				"peer inline-flex shrink-0 cursor-pointer items-center rounded-full outline-none transition-[background,border-color,box-shadow] duration-200 focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50",
				className,
			)}
			{...props}
		>
			<SwitchPrimitive.Thumb
				data-slot="switch-thumb"
				className="pointer-events-none block rounded-full transition-[transform,background,box-shadow] duration-200 ease-[cubic-bezier(0.34,1.4,0.64,1)]"
			/>
		</SwitchPrimitive.Root>
	);
}

export { Switch };
