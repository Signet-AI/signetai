import { Skeleton } from "@/components/ui/skeleton";
import { type DailyReflection, api } from "@/lib/api";
import { cn } from "@/lib/utils";
import { ChevronLeft, ChevronRight, RotateCw } from "@/components/mingcute-icons";
import { useCallback, useEffect, useRef, useState } from "react";
const BRIEF_CHAR_BUDGET = 236;

function formatBriefDate(date: string): string {
	const parsed = new Date(`${date}T12:00:00`);
	if (parsed.toDateString() === new Date().toDateString()) return "Today";
	return Number.isNaN(parsed.getTime())
		? date
		: parsed.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function budgetText(text: string, budget: number): string {
	if (text.length <= budget) return text;
	const cut = text.slice(0, budget);
	const lastSpace = cut.lastIndexOf(" ");
	return `${cut.slice(0, lastSpace > budget * 0.6 ? lastSpace : budget).replace(/[\s.,;:!?—–-]+$/, "")}…`;
}

export function DailyBrief({
	agentId,
	agentSettled = true,
	children,
}: {
	agentId?: string;
	agentSettled?: boolean;
	children?: React.ReactNode;
}) {
	const [reflections, setReflections] = useState<DailyReflection[]>([]);
	const [loading, setLoading] = useState(true);
	const [generating, setGenerating] = useState(false);
	const [slow, setSlow] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const [emptyMsg, setEmptyMsg] = useState<string | null>(null);
	const [i, setI] = useState(0);
	const [draftFor, setDraftFor] = useState<string | null>(null);
	const [answerText, setAnswerText] = useState("");
	const [submitting, setSubmitting] = useState(false);
	const generationToken = useRef(0);
	const items = reflections;
	const clamped = items.length === 0 ? 0 : Math.min(i, items.length - 1);
	const current = items[clamped] ?? null;

	const generate = useCallback(
		async (count?: number) => {
			const token = ++generationToken.current;
			setGenerating(true);
			setSlow(false);
			setError(null);
			const slowTimer = setTimeout(() => {
				if (generationToken.current === token) setSlow(true);
			}, 10_000);
			const result = await api.generateReflections(agentId, count);
			clearTimeout(slowTimer);
			if (generationToken.current !== token) return;
			setGenerating(false);
			setSlow(false);
			if (result.error) {
				setError(result.error);
				return;
			}
			const next = (result.reflections ?? (result.reflection ? [result.reflection] : [])).filter((r) => r.summary);
			if (next.length > 0) {
				setReflections((existing) => {
					const seen = new Set(existing.map((r) => r.id));
					return [...next.filter((r) => !seen.has(r.id)), ...existing];
				});
				setI(0);
				setEmptyMsg(null);
			} else {
				setEmptyMsg(result.message ?? "No new brief is available yet.");
			}
		},
		[agentId],
	);
	useEffect(() => {
		if (!agentSettled) return;
		let active = true;
		void (async () => {
			setLoading(true);
			const today = await api.getTodayReflections(agentId);
			if (!active) return;
			const items = today?.reflections ?? (today?.reflection ? [today.reflection] : []);
			setReflections(items);
			setLoading(false);
			if (items.length === 0) void generate();
		})();
		return () => {
			active = false;
			generationToken.current += 1;
			setGenerating(false);
			setSlow(false);
		};
	}, [agentId, agentSettled, generate]);

	const submitAnswer = async (item: DailyReflection) => {
		if (!answerText.trim() || submitting) return;
		setSubmitting(true);
		setError(null);
		const result = await api.answerReflection(item.id, answerText, agentId);
		setSubmitting(false);
		if (result.success) {
			const saved = answerText.trim();
			setReflections((existing) =>
				existing.map((r) => (r.id === item.id ? { ...r, answer: saved, answerMemoryId: result.memoryId ?? null } : r)),
			);
			setAnswerText("");
			setDraftFor(null);
		} else {
			setError(result.error ?? "Unable to save your answer. Try again.");
		}
	};

	const show = (n: number) => setI(((n % items.length) + items.length) % items.length);

	return (
		<section className="home-daily-brief flex flex-col gap-3">
			<div className="flex shrink-0 items-center justify-between gap-3">
				<span className="text-small font-medium text-muted-foreground">Daily brief</span>
				<button
					type="button"
					aria-label="Generate a new brief"
					title={draftFor ? "Save or cancel your draft before refreshing" : "Generate a new brief"}
					disabled={generating || loading || draftFor !== null}
					onClick={() => void generate(1)}
					className="home-brief-icon"
				>
					<RotateCw className={cn("size-3.5", generating && "animate-spin")} />
				</button>
			</div>

			{loading && current === null ? (
				<>
					{}
					<div className="flex shrink-0 flex-col gap-2.25" aria-label="Loading daily brief">
						<div>
							{[0, 1, 2].map((idx) => (
								<div key={idx} className="flex h-[25px] items-center">
									<Skeleton className={idx === 2 ? "h-4 w-[55%]" : "h-4 w-full"} />
								</div>
							))}
						</div>
						<div className="mt-1 flex h-[15.8px] shrink-0 items-center">
							<Skeleton className="h-[10.5px] w-20" />
						</div>
					</div>
				</>
			) : current ? (
				<div className="flex shrink-0 flex-col gap-2.25">
					<div
						key={current.id}
						className="insight-text home-brief-copy text-foreground"
						title={current.summary.length > BRIEF_CHAR_BUDGET ? current.summary : undefined}
					>
						{budgetText(current.summary, BRIEF_CHAR_BUDGET)}
					</div>
					<div className="home-brief-footer">
						<span className="min-w-0 truncate text-meta tabular-nums text-muted-foreground">
							{error && draftFor === null ? (
								<span className="text-destructive">{error}</span>
							) : current.patterns.length > 0 ? (
								current.patterns.slice(0, 4).join(" · ")
							) : current.answer ? (
								"Answered"
							) : (
								formatBriefDate(current.date)
							)}
						</span>
						<div className="flex shrink-0 items-center gap-2">
							{!current.answer && draftFor !== current.id && (
								<button
									type="button"
									disabled={generating}
									onClick={() => {
										setAnswerText("");
										setError(null);
										setDraftFor(current.id);
									}}
									className="home-brief-reply"
								>
									{generating ? "Generating…" : "Write back"}
								</button>
							)}
							{items.length > 1 && (
								<div className="home-brief-pager">
									<button
										type="button"
										aria-label="Previous brief"
										disabled={draftFor !== null}
										onClick={() => show(clamped - 1)}
										className="home-brief-icon"
									>
										<ChevronLeft className="size-3.5" />
									</button>
									<span className="text-meta tabular-nums text-muted-foreground">
										{clamped + 1} of {items.length}
									</span>
									<button
										type="button"
										aria-label="Next brief"
										disabled={draftFor !== null}
										onClick={() => show(clamped + 1)}
										className="home-brief-icon"
									>
										<ChevronRight className="size-3.5" />
									</button>
								</div>
							)}
						</div>
					</div>

					{current.answer ? (
						<div className="mt-1 flex flex-col gap-1.5 rounded-[var(--radius)] border border-[oklch(1_0_0/0.06)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] px-2.5 py-2">
							<span className="text-meta tabular-nums uppercase tracking-[0.08em] text-muted-foreground">
								Your answer
							</span>
							<p className="m-0 line-clamp-2 text-body leading-[1.55] text-foreground" title={current.answer}>
								{current.answer}
							</p>
						</div>
					) : draftFor === current.id ? (
						<div className="mt-1 flex flex-col gap-2">
							<textarea
								value={answerText}
								onChange={(e) => setAnswerText(e.target.value)}
								placeholder="Type your reflection…"
								rows={2}
								autoFocus
								aria-label="Your answer"
								className="w-full resize-none rounded-xl border border-[oklch(1_0_0/0.1)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] px-2.5 py-1.5 text-small leading-[1.5] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-[color-mix(in_oklch,var(--foreground)_30%,transparent)]"
							/>
							<div className="flex items-center gap-2">
								<button
									type="button"
									disabled={!answerText.trim() || submitting}
									onClick={() => void submitAnswer(current)}
									className="h-7 rounded-full bg-foreground px-3.5 text-small font-medium text-background transition-opacity hover:opacity-88 disabled:opacity-40"
								>
									{submitting ? "Saving…" : "Save"}
								</button>
								<button
									type="button"
									onClick={() => {
										setDraftFor(null);
										setAnswerText("");
									}}
									className="h-7 rounded-full px-3 text-small text-muted-foreground transition-colors hover:text-foreground"
								>
									Cancel
								</button>
								{error && <span className="text-meta tabular-nums text-destructive">{error}</span>}
							</div>
						</div>
					) : null}
				</div>
			) : (
				<div className="flex shrink-0 flex-col gap-2.5">
					<p className="m-0 text-body leading-[1.55] text-muted-foreground">
						{generating
							? slow
								? "Generation is taking longer than expected. It may take a minute…"
								: "Generating today's briefs from recent memories…"
							: (error ?? emptyMsg ?? "No daily brief is available yet.")}
					</p>
					{!generating && (
						<div>
							<button
								type="button"
								onClick={() => void generate()}
								className="h-6 rounded-[var(--radius)] border border-[oklch(1_0_0/0.16)] bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] px-2.5 text-meta font-medium transition-colors hover:border-[oklch(1_0_0/0.3)] hover:bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)]"
							>
								Generate today's briefs
							</button>
						</div>
					)}
				</div>
			)}

			{children}
		</section>
	);
}
