import type { ComponentProps, ReactNode } from "react";
import { Search } from "@/components/mingcute-icons";
import { cn } from "@/lib/utils";

export function Input({ className, ...props }: ComponentProps<"input">) {
	return <input className={cn("ui-field", className)} {...props} />;
}

export function NativeSelect({ className, ...props }: ComponentProps<"select">) {
	return <select className={cn("ui-field", className)} {...props} />;
}

export function SearchField({ className, ...props }: ComponentProps<"input">) {
	return (
		<div className={cn("ui-search-field", className)}>
			<Search className="ui-search-icon shrink-0 text-muted-foreground" aria-hidden="true" />
			<Input type="search" aria-label={props.placeholder} {...props} />
		</div>
	);
}

export function Field({
	label,
	htmlFor,
	hint,
	children,
}: {
	label: string;
	htmlFor: string;
	hint?: ReactNode;
	children: ReactNode;
}) {
	return (
		<label htmlFor={htmlFor} className="ui-field-label">
			<span>{label}</span>
			{children}
			{hint && <span className="ui-field-hint">{hint}</span>}
		</label>
	);
}
