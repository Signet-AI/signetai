import { cn } from "@/lib/utils";

export function NotPermitted({
	what,
	permission,
	className,
}: {
	what: string;
	permission: string;
	className?: string;
}) {
	return (
		<div role="status" className={cn("flex flex-col gap-1 rounded-lg border border-dashed px-4 py-3", className)}>
			<p className="m-0 text-body font-medium">
				{what} requires the {permission} permission.
			</p>
			<p className="m-0 text-small text-muted-foreground">
				Your credential doesn't include it. Ask whoever runs this Signet instance for access.
			</p>
		</div>
	);
}
