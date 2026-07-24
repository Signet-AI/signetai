import { Plus } from "lucide-react";
import { Surface } from "@/components/ui/surface";
import { sourceLogo } from "@/components/icons";
import { api, type SignetSource } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";

const HEALTH_STYLES: Record<string, string> = {
	healthy: "text-[oklch(0.72_0.15_150)]",
	degraded: "text-[oklch(0.75_0.15_85)]",
	unhealthy: "text-[oklch(0.7_0.18_25)]",
	empty: "text-muted-foreground",
};

export function SourcesView() {
	const { sources } = useAsync(() => api.getSources(), { intervalMs: 30000 }).data ?? {};

	return (
		<div className="flex flex-1 flex-col gap-3 min-h-0">
			<div className="flex shrink-0 items-center gap-2.5 px-0.5 pb-3.5 font-mono">
				<HeroStat value={String(sources?.length ?? "—")} label="sources" />
				<Sep />
				<HeroStat value={String(sources?.filter((s) => s.enabled).length ?? "—")} label="active" />
				<Sep />
				<HeroStat
					value={String(sources?.filter((s) => s.health?.status === "healthy").length ?? "—")}
					label="healthy"
				/>
				<div className="flex-1" />
			</div>

			<div className="grid flex-1 grid-cols-1 gap-3 overflow-y-auto pb-2 md:grid-cols-2 [mask-image:linear-gradient(180deg,#000_0,#000_calc(100%-24px),transparent_100%)]">
				{(sources ?? []).map((s) => (
					<SourceCard key={s.id} source={s} />
				))}
				<button
					type="button"
					className="flex min-h-[180px] flex-col items-center justify-center gap-2.5 rounded-[var(--radius)] border-[1.5px] border-dashed border-[oklch(1_0_0/0.12)] bg-[color-mix(in_oklch,var(--card)_86%,transparent)] p-4 transition-colors hover:border-[color-mix(in_oklch,var(--success)_45%,transparent)] hover:bg-[color-mix(in_oklch,var(--success)_5%,transparent)]"
				>
					<span className="grid size-10 place-items-center rounded-full border border-[oklch(1_0_0/0.08)] bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)] text-muted-foreground transition-colors hover:border-[color-mix(in_oklch,var(--success)_40%,transparent)] hover:text-[oklch(0.82_0.16_150)]">
						<Plus className="size-[18px]" />
					</span>
					<span className="text-[12.5px] font-medium">Connect a source</span>
					<span className="font-mono text-[9.5px] text-muted-foreground">obsidian · github · discord</span>
				</button>
			</div>
		</div>
	);
}

function SourceCard({ source }: { source: SignetSource }) {
	const health = source.health?.status ?? "empty";
	return (
		<Surface className="sig-src-card sig-keylight-src flex flex-col gap-2.5 p-4">
			<div className="flex items-center gap-3">
				<span className="grid size-9.5 shrink-0 place-items-center rounded-[9px] border border-[oklch(1_0_0/0.06)] bg-[color-mix(in_oklch,var(--foreground)_5%,transparent)] text-foreground">
					{sourceLogo(source.kind, { className: "size-5" }) ?? <span className="text-xs">●</span>}
				</span>
				<div className="min-w-0 flex-1">
					<div className="text-[14px] font-semibold leading-tight tracking-tight">{source.name}</div>
					<div className="mt-0.5 flex items-center gap-1.5 font-mono text-[9.5px] uppercase tracking-[0.06em] text-muted-foreground">
						<span>{source.kind}</span>
						<span>·</span>
						<span>{source.mode}</span>
					</div>
				</div>
				<span className={cn("flex items-center gap-1.25 font-mono text-[9.5px] font-medium", HEALTH_STYLES[health])}>
					<span className="size-1.5 rounded-full bg-current shadow-[0_0_6px_currentColor]" />
					{health}
				</span>
			</div>

			<div className="flex h-7 items-center gap-1.75 overflow-hidden rounded-md bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] px-2">
				<span className="truncate font-mono text-[10.5px] text-muted-foreground">{source.root}</span>
			</div>

			<div className="grid grid-cols-3 gap-2">
				<MiniStat value={source.stats?.artifacts?.toLocaleString() ?? "—"} label="artifacts" />
				<MiniStat value={source.stats?.chunks?.toLocaleString() ?? "—"} label="chunks" />
				<MiniStat value={source.stats?.indexed?.toLocaleString() ?? "—"} label="indexed" />
			</div>

			<div className="flex items-center justify-between border-t border-[oklch(1_0_0/0.06)] pt-2">
				<span className="font-mono text-[9.5px] text-muted-foreground">
					{source.lastIndexedAt ? `indexed ${timeAgo(source.lastIndexedAt)}` : "never indexed"}
				</span>
			</div>
		</Surface>
	);
}

function HeroStat({ value, label }: { value: string; label: string }) {
	return (
		<span className="flex items-baseline gap-1.5">
			<span className="font-mono text-[12px] font-medium tracking-tight">{value}</span>
			<span className="text-[10.5px] text-muted-foreground">{label}</span>
		</span>
	);
}
function Sep() {
	return <span className="text-[oklch(0.35_0_0)] [html:not(.dark)_&]:text-[oklch(0.65_0_0)]">·</span>;
}
function MiniStat({ value, label }: { value: string; label: string }) {
	return (
		<div className="flex flex-col gap-0.5 rounded-[7px] bg-[color-mix(in_oklch,var(--foreground)_2.5%,transparent)] px-2.5 py-2">
			<span className="font-mono text-[14px] font-medium tracking-tight">{value}</span>
			<span className="text-[9px] uppercase tracking-[0.05em] text-muted-foreground">{label}</span>
		</div>
	);
}

function timeAgo(iso: string): string {
	const ms = Date.now() - new Date(iso).getTime();
	const min = Math.round(ms / 60000);
	if (min < 60) return `${min}m ago`;
	const hr = Math.round(min / 60);
	if (hr < 24) return `${hr}h ago`;
	return `${Math.round(hr / 24)}d ago`;
}
