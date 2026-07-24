import { Search } from "lucide-react";
import { Surface } from "@/components/ui/surface";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { useState } from "react";

const TYPE_TINTS: Record<string, string> = {
	decision: "text-[oklch(0.82_0.16_150)]",
	issue: "text-[oklch(0.78_0.18_25)]",
	learning: "text-[oklch(0.82_0.14_200)]",
};

/**
 * Daemon `tags` is inconsistent: sometimes a string (comma/newline-delimited),
 * sometimes an array, sometimes null. Coerce to a clean string array.
 */
function toTagArray(tags: unknown): string[] {
	if (Array.isArray(tags))
		return tags.filter((t): t is string => typeof t === "string").map((t) => t.trim()).filter(Boolean);
	if (typeof tags === "string") return tags.split(/[\s,]+/).map((t) => t.trim()).filter(Boolean);
	return [];
}

export function MemoryView() {
	const [q, setQ] = useState("");
	const mems = useAsync(
		async () => (q.trim() ? api.searchMemories(q) : api.getMemories({ limit: 50 })),
		{ deps: [q] },
	).data;

	return (
		<div className="flex flex-1 flex-col gap-3.5 min-h-0">
			<Surface className="flex h-10 shrink-0 items-center gap-2.5 px-3.5">
				<Stat label="memories" value="8.1k" />
				<Stat label="indexed" value="92%" />
				<Stat label="pinned" value="14" />
				<div className="flex-1" />
				<span className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
					<span className="size-1.5 rounded-full bg-success shadow-[0_0_6px_color-mix(in_oklch,var(--success)_60%,transparent)]" />
					pipeline live
				</span>
			</Surface>

			<div
				className={cn(
					"flex h-10 shrink-0 items-center gap-2.5 rounded-[var(--radius)] border px-3.5",
					"border-[oklch(1_0_0/0.14)] bg-[color-mix(in_oklch,var(--foreground)_4%,transparent)]",
					"focus-within:border-[color-mix(in_oklch,var(--foreground)_35%,transparent)] focus-within:shadow-[0_0_0_3px_color-mix(in_oklch,var(--foreground)_8%,transparent)]",
				)}
			>
				<Search className="size-4 text-muted-foreground" />
				<Input
					value={q}
					onChange={(e) => setQ(e.target.value)}
					placeholder="Search memories…"
					className="h-full border-0 bg-transparent p-0 text-[13px] shadow-none focus-visible:ring-0"
				/>
				{q && (
					<span className="font-mono text-[10px] text-success">{mems?.memories?.length ?? 0} ranked</span>
				)}
			</div>

			<div className="grid flex-1 min-h-0 grid-cols-1 gap-4 md:grid-cols-[1fr_240px]">
				<div className="flex flex-col gap-2 overflow-y-auto pr-1">
					{(mems?.memories ?? []).map((m) => (
						<Surface key={m.id} className="sig-keylight-feed flex gap-3 px-3.5 py-3" glow={false}>
							<div className="flex-1 min-w-0">
								<div className="mb-1 flex items-center gap-1.5">
									<span className="text-[11.5px] font-semibold">{m.who}</span>
									{m.type && (
										<span
											className={cn(
												"rounded px-1.5 py-px font-mono text-[9px] bg-[color-mix(in_oklch,var(--foreground)_8%,transparent)] border border-[oklch(1_0_0/0.06)]",
												TYPE_TINTS[m.type] ?? "text-muted-foreground",
											)}
										>
											{m.type}
										</span>
									)}
								</div>
								<p className="m-0 text-[12.5px] leading-[1.55] text-foreground">{m.content}</p>
								<div className="mt-2 flex flex-wrap items-center gap-2">
									{toTagArray(m.tags).slice(0, 4).map((t) => (
										<span key={t} className="font-mono text-[9.5px] text-muted-foreground">
											#{t}
										</span>
									))}
									<span className="ml-auto font-mono text-[9.5px] text-muted-foreground">
										{new Date(m.created_at).toLocaleDateString()}
									</span>
								</div>
							</div>
						</Surface>
					))}
					{(mems?.memories ?? []).length === 0 && (
						<div className="grid flex-1 place-items-center p-8 text-center text-[12px] text-muted-foreground">
							{q ? `No memories match "${q}"` : "Loading memories…"}
						</div>
					)}
				</div>

				<Surface className="hidden flex-col gap-3 p-3 md:flex">
					<SideGroup label="Workflow">
						{["semantic", "episodic", "procedural"].map((w) => (
							<SideChip key={w} label={w} />
						))}
					</SideGroup>
				</Surface>
			</div>
		</div>
	);
}

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<span className="flex h-full items-center gap-1.5 border-r border-[oklch(1_0_0/0.07)] px-4 last:border-r-0">
			<span className="font-mono text-[13px] font-medium">{value}</span>
			<span className="text-[11px] text-muted-foreground">{label}</span>
		</span>
	);
}

function SideGroup({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="flex flex-col gap-1.5">
			<div className="px-0.5 font-mono text-[9.5px] font-semibold uppercase tracking-[0.08em] text-[oklch(0.58_0_0)]">
				{label}
			</div>
			{children}
		</div>
	);
}

function SideChip({ label }: { label: string }) {
	return (
		<button
			type="button"
			className="flex items-center gap-2 rounded-[var(--radius)] border border-[oklch(1_0_0/0.06)] px-2.5 py-1.75 text-[12px] text-muted-foreground transition-colors hover:bg-[var(--accent-subtle)] hover:text-foreground"
		>
			<span className="capitalize">{label}</span>
		</button>
	);
}
