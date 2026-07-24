import { forwardRef, type HTMLAttributes } from "react";
import { cn } from "@/lib/utils";
import { useCursorGlow } from "@/lib/use-cursor-glow";

/**
 * Surface card — the shared container for KPI cards, panels, the daily brief,
 * activity card, memory feed items, source cards. Applies the mockup's
 * `.sig-surface` treatment (mask-composite key-light border + cursor-tracking
 * radial glow). Use `glow` to enable the hover glow (default on).
 */
export interface SurfaceProps extends HTMLAttributes<HTMLDivElement> {
	glow?: boolean;
}

export const Surface = forwardRef<HTMLDivElement, SurfaceProps>(
	({ className, glow = true, onMouseMove, ...props }, ref) => {
		const { onMouseMove: glowMove } = useCursorGlow<HTMLDivElement>();
		return (
			<div
				ref={ref}
				className={cn("sig-surface rounded-[var(--radius)] bg-card", className)}
				onMouseMove={glow ? glowMove : onMouseMove}
				{...(glow ? {} : { onMouseMove })}
				{...props}
			/>
		);
	},
);
Surface.displayName = "Surface";
