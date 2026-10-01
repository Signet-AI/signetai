import type { ReactNode } from "react";

export function Metric({ label, value }: { label: string; value: ReactNode }) {
	return (
		<div className="ui-metric">
			<div className="ui-metric-label">{label}</div>
			<div className="ui-metric-value">{value}</div>
		</div>
	);
}
