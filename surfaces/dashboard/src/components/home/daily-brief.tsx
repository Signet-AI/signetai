import { useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import { Surface } from "@/components/ui/surface";
import { cn } from "@/lib/utils";

export interface BriefInsight {
	text: React.ReactNode;
	tag: string;
}

export function DailyBrief({ insights, caption }: { insights: BriefInsight[]; caption: string }) {
	const [i, setI] = useState(0);
	const pad = (n: number) => String(n + 1).padStart(2, "0");
	const show = (n: number) => setI(((n % insights.length) + insights.length) % insights.length);

	return (
		<Surface className="flex flex-col gap-4 px-4.5 py-4">
			<div className="flex items-center justify-between gap-3">
				<span className="text-[13px] font-semibold tracking-tight text-foreground">Daily brief</span>
				<div className="flex items-center gap-2.5">
					<span className="font-mono text-[11px] text-muted-foreground">
						{pad(i)} / {pad(insights.length - 1)}
					</span>
					<div className="flex gap-[5px]">
						{insights.map((_, idx) => (
							<i
								key={idx}
								className={cn(
									"size-[5px] rounded-full transition-colors",
									idx === i ? "bg-foreground" : "bg-border",
								)}
							/>
						))}
					</div>
					<button
						type="button"
						aria-label="Previous brief"
						onClick={() => show(i - 1)}
						className="grid size-6 place-items-center rounded-[var(--radius)] border border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<ChevronLeft className="size-3.5" />
					</button>
					<button
						type="button"
						aria-label="Next brief"
						onClick={() => show(i + 1)}
						className="grid size-6 place-items-center rounded-[var(--radius)] border border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground"
					>
						<ChevronRight className="size-3.5" />
					</button>
				</div>
			</div>

			<div className="flex flex-col gap-2.25">
				<div className="insight-text text-[16px] leading-[1.6] tracking-[-0.005em] text-foreground [&_b]:font-semibold [&_.mono]:font-mono [&_.mono]:text-muted-foreground">
					{insights[i].text}
				</div>
				<div className="mt-1 font-mono text-[10.5px] text-muted-foreground">{insights[i].tag}</div>
			</div>

			<div className="font-mono text-[10.5px] text-muted-foreground">{caption}</div>
		</Surface>
	);
}
