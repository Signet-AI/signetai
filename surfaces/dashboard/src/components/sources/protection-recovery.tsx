import { useAsync } from "@/lib/use-async";
import { api, type DashboardProtectionReport } from "@/lib/api";
import { protectionSummary } from "@/lib/dashboard-protection";

export function ProtectionRecoveryPanel({ report }: { report?: DashboardProtectionReport }) {
	if (!report)
		return (
			<section aria-label="Protection recovery" className="rounded border p-4">
				<span className="font-mono text-xs text-muted-foreground">Protection status unavailable.</span>
			</section>
		);
	const summary = protectionSummary(report);
	return (
		<section aria-label="Protection recovery" className="rounded border p-4">
			<div className="flex items-center justify-between gap-3">
				<h2 className="text-sm font-semibold">Protection &amp; recovery</h2>
				<strong className="font-mono text-xs">{summary.overallLabel}</strong>
			</div>
			<p className="mt-1 font-mono text-[10px] text-muted-foreground">
				{summary.restore.testedAt
					? `Restore tested ${new Date(summary.restore.testedAt).toLocaleString()} · ${summary.restore.scope ?? "scope unavailable"}`
					: "Restore test not recorded"}
			</p>
			<div className="mt-3 grid gap-3 sm:grid-cols-2">
				{summary.groups.map((group) => (
					<div key={group.name}>
						<h3 className="font-mono text-[10px] uppercase text-muted-foreground">{group.name}</h3>
						<ul className="mt-1 space-y-1">
							{group.components.map((component) => (
								<li key={component.name} className="flex justify-between gap-2 text-xs">
									<span>
										{component.name}
										{component.reason && <span className="ml-2 text-muted-foreground">— {component.reason}</span>}
									</span>
									<span className="font-mono text-[10px]">
										{component.state}
										{component.remediation && <span className="ml-2 underline">{component.remediation}</span>}
									</span>
								</li>
							))}
						</ul>
					</div>
				))}
			</div>
		</section>
	);
}

export function ProtectionRecoveryData() {
	const { data } = useAsync(() => api.getProtection(), { intervalMs: 30000 });
	return <ProtectionRecoveryPanel report={data?.data ?? undefined} />;
}
