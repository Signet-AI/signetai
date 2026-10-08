export function PanelIcon({ side, className }: { side: "left" | "right"; className?: string }) {
	return (
		<svg
			aria-hidden="true"
			viewBox="0 0 24 24"
			fill="none"
			stroke="currentColor"
			strokeWidth="1.5"
			className={className}
		>
			<rect x="3" y="4.5" width="18" height="15" rx="3" />
			<path d={side === "left" ? "M9 4.5v15" : "M15 4.5v15"} />
		</svg>
	);
}
