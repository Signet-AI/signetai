import type { ReactNode } from "react";
import { Button } from "@/components/ui/button";
import { X } from "@/components/mingcute-icons";
import { cn } from "@/lib/utils";

export function ModalHeading({
	title,
	description,
	icon,
	onClose,
	disabled,
	className,
}: {
	title: ReactNode;
	description?: ReactNode;
	icon?: ReactNode;
	onClose: () => void;
	disabled?: boolean;
	className?: string;
}) {
	return (
		<header className={cn("ui-modal-heading", className)}>
			{icon && <span className="ui-modal-icon">{icon}</span>}
			<div className="min-w-0 flex-1">
				<h2 className="m-0 text-[15px] font-semibold tracking-tight">{title}</h2>
				{description && <p className="m-0 mt-0.5 font-mono text-[9.5px] text-muted-foreground">{description}</p>}
			</div>
			<Button variant="ghost" size="icon-sm" onClick={onClose} disabled={disabled} aria-label="Close">
				<X className="size-4" />
			</Button>
		</header>
	);
}
