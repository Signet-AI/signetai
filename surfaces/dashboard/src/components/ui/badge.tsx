import type { ReactNode } from "react";

export function Badge({ children }: { readonly children: ReactNode }) {
	return (
		<span className="rounded border border-border bg-muted px-1.5 py-0.5 text-meta tabular-nums text-muted-foreground">
			{children}
		</span>
	);
}
