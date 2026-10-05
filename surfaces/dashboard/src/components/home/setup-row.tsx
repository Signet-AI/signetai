import { ChevronRight } from "@/components/mingcute-icons";
import type { ReactNode } from "react";
export function SetupRow({
	id,
	label,
	summary,
	count,
	expanded,
	onToggle,
	onOpen,
}: {
	id: string;
	label: string;
	summary: ReactNode;
	count?: ReactNode;
	expanded?: boolean;
	onToggle?: () => void;
	onOpen?: () => void;
}) {
	return (
		<button
			type="button"
			className="home-setup-row"
			aria-expanded={onToggle ? expanded : undefined}
			aria-labelledby={id}
			onClick={onToggle ?? onOpen}
		>
			<span id={id} className="home-setup-label">
				{label}
			</span>
			<span className="home-setup-summary">{summary}</span>
			<span className="home-setup-count">{count}</span>
			<ChevronRight className="home-setup-chevron" aria-hidden="true" />
		</button>
	);
}
