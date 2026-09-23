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
			<div className="mt-3 space-y-3">
				{summary.groups.map((group) => (
					<div key={group.name}>
						<h3 className="text-[11px] uppercase text-slate-500 dark:text-slate-400">{group.name}</h3>
						<ul aria-label="Protection components" className="mt-1 divide-y divide-border/50">
							{group.components.map((component) => (
								<li key={component.name} className="grid grid-cols-[minmax(0,1fr)_auto] gap-x-3 py-1.5">
									<span className="min-w-0 text-[12px] font-medium">{component.name}</span>
									<span className="whitespace-nowrap font-mono text-[11px] text-slate-500 dark:text-slate-400">
										{component.state}
									</span>
									{component.reason && (
										<p className="col-span-2 mt-0.5 text-[12px] leading-4 text-slate-500 dark:text-slate-400">
											{component.reason}
										</p>
									)}
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
