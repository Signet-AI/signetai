import type { ComponentProps, ReactNode } from "react";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "./dialog";

export function ConfirmationDialog({
	title,
	description,
	actions,
	children,
	contentProps,
	...props
}: Pick<ComponentProps<typeof Dialog>, "open" | "onOpenChange"> & {
	title: ReactNode;
	description: ReactNode;
	actions: ReactNode;
	children?: ReactNode;
	contentProps?: Omit<ComponentProps<typeof DialogContent>, "children">;
}) {
	return (
		<Dialog {...props}>
			<DialogContent {...contentProps}>
				<DialogHeader>
					<DialogTitle>{title}</DialogTitle>
					<DialogDescription>{description}</DialogDescription>
				</DialogHeader>
				{children}
				<DialogFooter>{actions}</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
