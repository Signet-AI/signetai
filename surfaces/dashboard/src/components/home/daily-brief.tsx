/**
 * Daily brief — daemon-generated reflection questions, ported from the old
 * Svelte DailyReflection: load today's, auto-generate one when none exists,
 * manual regenerate, and the write-back answer flow (saved into the memory
 * thread via POST /api/reflections/:id/answer). Pager visual per the mockup.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, RotateCw } from "lucide-react";
import { Surface } from "@/components/ui/surface";
import { api, type DailyReflection } from "@/lib/api";
import { cn } from "@/lib/utils";

/**
 * Mockup-sized card: the fake insights in the mockup are all ~210-230 chars
 * (three lines at 16px). Cap real questions to the same budget so the card
 * never resizes with generated content. Full text remains on hover.
 */
const BRIEF_CHAR_BUDGET = 240;

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
	/** False until /api/status resolves — fetching/generating before the real
	 *  agent id is known would hit the daemon's `default` agent (scoping leak). */
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

	const questions = reflections.filter((r) => r.question);
	const clamped = questions.length === 0 ? 0 : Math.min(i, questions.length - 1);
	const current = questions[clamped] ?? null;

	const generate = useCallback(async () => {
		const token = ++generationToken.current;
		setGenerating(true);
		setSlow(false);
		setError(null);
		const slowTimer = setTimeout(() => {
			if (generationToken.current === token) setSlow(true);
		}, 10_000);
		const result = await api.generateReflections(agentId, 1);
		clearTimeout(slowTimer);
		if (generationToken.current !== token) return;
		setGenerating(false);
		setSlow(false);
		if (result.error) {
			setError(result.error);
			return;
		}
		const next = (result.reflections ?? (result.reflection ? [result.reflection] : [])).filter((r) => r.question);
		if (next.length > 0) {
			setReflections((existing) => {
				const seen = new Set(existing.map((r) => r.id));
				return [...next.filter((r) => !seen.has(r.id)), ...existing];
			});
			setI(0); // newest question first
			setEmptyMsg(null);
		} else {
			setEmptyMsg(result.message ?? "No new question found yet");
		}
	}, [agentId]);

	// Svelte method: load today's reflections; auto-generate when none has a question.
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
			if (!items.some((r) => r.question)) void generate();
		})();
		return () => {
			active = false;
			// Invalidate any in-flight generation owned by this effect run and
			// release the flags so `generating` can never latch on.
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
				existing.map((r) =>
					r.id === item.id ? { ...r, answer: saved, answerMemoryId: result.memoryId ?? null } : r,
				),
			);
			setAnswerText("");
			setDraftFor(null);
		} else {
			setError(result.error ?? "Failed to save answer");
		}
	};

	const pad = (n: number) => String(n + 1).padStart(2, "0");
	const show = (n: number) => setI(((n % questions.length) + questions.length) % questions.length);

	return (
		<Surface className="flex flex-col gap-3.5 px-4.5 py-3.5">
			<div className="flex shrink-0 items-center justify-between gap-3">
				<span className="text-[13px] font-semibold tracking-tight text-foreground">Daily brief</span>
				<div className="flex items-center gap-2.5">
					{questions.length > 0 && (
						<span className="font-mono text-[11px] text-muted-foreground">
							{pad(clamped)} / {pad(questions.length - 1)}
						</span>
					)}
					{questions.length > 1 && (
						<div className="flex gap-[5px]">
							{questions.map((q, idx) => (
								<i
									key={q.id}
									className={cn(
										"size-[5px] rounded-full transition-colors",
										idx === clamped ? "bg-foreground" : "bg-border",
									)}
								/>
							))}
						</div>
					)}
					<button
						type="button"
						aria-label="Generate a new question"
						title={draftFor ? "Save or cancel your draft before refreshing" : "Generate a new question"}
						disabled={generating || loading || draftFor !== null}
						onClick={() => void generate()}
						className="grid size-6 place-items-center rounded-[var(--radius)] border border-border bg-card text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
					>
						<RotateCw className={cn("size-3.5", generating && "animate-spin")} />
					</button>
					{questions.length > 1 && (
						<>
							<button
								type="button"
								aria-label="Previous brief"
								disabled={draftFor !== null}
								onClick={() => show(clamped - 1)}
								className="grid size-6 place-items-center rounded-[var(--radius)] border border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
							>
								<ChevronLeft className="size-3.5" />
							</button>
							<button
								type="button"
								aria-label="Next brief"
								disabled={draftFor !== null}
								onClick={() => show(clamped + 1)}
								className="grid size-6 place-items-center rounded-[var(--radius)] border border-border bg-card text-muted-foreground hover:bg-accent hover:text-foreground disabled:opacity-40"
							>
								<ChevronRight className="size-3.5" />
							</button>
						</>
					)}
				</div>
			</div>

			{loading ? (
				<>
					{/* Height-exact mirror of the loaded layout (text 76.8 / tag 15.8)
					    so the card never moves on load. */}
					<div className="flex shrink-0 flex-col gap-2.25" aria-label="Loading daily brief">
						<div>
							{["100%", "100%", "55%"].map((w, idx) => (
								<div key={idx} className="flex h-[25.6px] items-center">
									<span
										className="block h-4 animate-pulse rounded bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)]"
										style={{ width: w }}
									/>
								</div>
							))}
						</div>
						<div className="mt-1 flex h-[15.8px] shrink-0 items-center">
							<span className="block h-[10.5px] w-20 animate-pulse rounded bg-[color-mix(in_oklch,var(--foreground)_7%,transparent)]" />
						</div>
					</div>
				</>
			) : current ? (
				<div className="flex shrink-0 flex-col gap-2.25">
					<div
						className="insight-text line-clamp-3 text-[16px] leading-[1.6] tracking-[-0.005em] text-foreground"
						title={current.summary.length > BRIEF_CHAR_BUDGET ? current.summary : undefined}
					>
						{budgetText(current.summary, BRIEF_CHAR_BUDGET)}
					</div>
					<div className="mt-1 flex items-baseline gap-2 font-mono text-[10.5px] text-muted-foreground">
						<span>
							{current.patterns.length > 0
								? current.patterns.slice(0, 4).join(" · ")
								: current.answer
									? "answered"
									: current.date}
						</span>
						{!current.answer && draftFor !== current.id && (
							<button
								type="button"
								disabled={generating}
								onClick={() => {
									setAnswerText("");
									setError(null);
									setDraftFor(current.id);
								}}
								className="transition-colors hover:text-foreground disabled:opacity-40"
							>
								· {generating ? "looking…" : "write back"}
							</button>
						)}
						{error && draftFor === null && <span className="text-destructive">{error}</span>}
					</div>

					{current.answer ? (
						<div className="mt-1 flex flex-col gap-1.5 rounded-[var(--radius)] border border-[oklch(1_0_0/0.06)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] px-2.5 py-2">
							<span className="font-mono text-[9.5px] uppercase tracking-[0.08em] text-muted-foreground">
								Your answer
							</span>
							<p className="m-0 line-clamp-2 text-[12.5px] leading-[1.55] text-foreground" title={current.answer}>
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
								className="w-full resize-none rounded-[var(--radius)] border border-[oklch(1_0_0/0.1)] bg-[color-mix(in_oklch,var(--foreground)_3%,transparent)] px-2.5 py-1.5 text-[12px] leading-[1.5] text-foreground outline-none transition-colors placeholder:text-muted-foreground focus:border-[color-mix(in_oklch,var(--foreground)_30%,transparent)]"
							/>
							<div className="flex items-center gap-2">
								<button
									type="button"
									disabled={!answerText.trim() || submitting}
									onClick={() => void submitAnswer(current)}
									className="h-6 rounded-[var(--radius)] bg-foreground px-2.5 text-[11px] font-medium text-background transition-opacity hover:opacity-88 disabled:opacity-40"
								>
									{submitting ? "Saving…" : "Save"}
								</button>
								<button
									type="button"
									onClick={() => {
										setDraftFor(null);
										setAnswerText("");
									}}
									className="h-6 rounded-[var(--radius)] px-2 text-[11px] text-muted-foreground transition-colors hover:text-foreground"
								>
									Cancel
								</button>
								{error && <span className="font-mono text-[9.5px] text-destructive">{error}</span>}
							</div>
						</div>
					) : null}
				</div>
			) : (
				<div className="flex shrink-0 flex-col gap-2.5">
					<p className="m-0 text-[13px] leading-[1.55] text-muted-foreground">
						{generating
							? slow
								? "Still thinking — generation can take a minute…"
								: "Generating today's question from your recent memories…"
							: (error ?? emptyMsg ?? "No daily brief yet.")}
					</p>
					{!generating && (
						<div>
							<button
								type="button"
								onClick={() => void generate()}
								className="h-6 rounded-[var(--radius)] border border-[oklch(1_0_0/0.16)] bg-[color-mix(in_oklch,var(--foreground)_6%,transparent)] px-2.5 text-[11px] font-medium transition-colors hover:border-[oklch(1_0_0/0.3)] hover:bg-[color-mix(in_oklch,var(--foreground)_10%,transparent)]"
							>
								Generate today's question
							</button>
						</div>
					)}
				</div>
			)}

			{children}
		</Surface>
	);
}
