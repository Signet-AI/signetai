import { cn } from "@/lib/utils";

export function Skeleton({ className }: { className?: string }) {
	return (
		<span
			aria-hidden="true"
			className={cn("block rounded-[var(--control-radius)] bg-muted/60 motion-safe:animate-pulse", className)}
		/>
	);
}
export function LoadingRows({ label, rows = 3 }: { label: string; rows?: number }) {
	return (
		<div role="status" aria-label={label} className="divide-y divide-border">
			<span className="sr-only">{label}</span>
			{Array.from({ length: rows }, (_, index) => (
				<div key={index} aria-hidden="true" className="flex items-center gap-3 py-3">
					<Skeleton className="size-7 shrink-0" />
					<div className="flex-1 space-y-2">
						<Skeleton className={index % 2 ? "h-3 w-2/3" : "h-3 w-4/5"} />
						<Skeleton className="h-2 w-1/3 opacity-60" />
					</div>
				</div>
			))}
		</div>
	);
}
