import { MessageResponse } from "@/components/ai-elements/message";
import { PageHeading, SectionHeading, StatusLabel } from "@/components/dashboard/heading";
import { Check, Loader2, RefreshCw, Trash2, X } from "@/components/mingcute-icons";
import { Button } from "@/components/ui/button";
import { ConfirmationDialog } from "@/components/ui/confirmation-dialog";
import {
	type BoardPost,
	type BoardStatus,
	type BoardStatusFilter,
	type BoardThread,
	type BoardThreadDetail,
	type BoardThreadList,
	type BoardThreadPatch,
	type DirectMessage,
	type PresenceSession,
	api,
	streamBoardEvents,
} from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import { useCallback, useEffect, useRef, useState } from "react";

const STATUS_FILTERS: readonly BoardStatusFilter[] = ["open", "resolved", "archived", "all"];
const THREAD_PAGE = 50;
const POST_PAGE = 200;
const STREAM_DEBOUNCE_MS = 300;
const STREAM_RETRY_MS = 3000;
const PREVIEW_CHARS = 140;

function relativeTime(value: string | null | undefined, now = Date.now()): string {
	if (!value) return "—";
	const iso = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(?:\.\d+)?$/.test(value) ? `${value.replace(" ", "T")}Z` : value;
	const time = new Date(iso).getTime();
	if (Number.isNaN(time)) return value;
	const seconds = Math.max(0, Math.round((now - time) / 1000));
	if (seconds < 60) return "just now";
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes}m ago`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours}h ago`;
	return `${Math.round(hours / 24)}d ago`;
}

function SessionLabel({
	agentId,
	sessionKey,
	sessions,
	harness,
}: {
	agentId: string;
	sessionKey?: string | null;
	sessions: readonly PresenceSession[];
	harness?: string | null;
}) {
	const matches = sessions.filter(
		(session) =>
			(agentId === "unknown" ? !!sessionKey : session.agentId === agentId) &&
			(!sessionKey || session.sessionKey === sessionKey),
	);
	const session = matches.length === 1 ? matches[0] : undefined;
	const key = sessionKey ?? session?.sessionKey;
	const project = session?.project ?? session?.context?.cwd;
	const agent = session?.agentId ?? agentId;
	const agentName = agent.length > 20 ? agent.slice(0, 8) : agent;
	const keyTag = key ? `#${key.slice(-6)}` : undefined;
	const name = session
		? [agentName, session.harness, project?.replace(/\/$/, "").split(/[\\/]/).pop(), keyTag].filter(Boolean).join(" · ")
		: [agentName, harness, keyTag].filter(Boolean).join(" · ");
	const task = session?.context?.task;
	const details = [session?.context?.title, task && (task.length > 80 ? `${task.slice(0, 80)}…` : task)].filter(
		Boolean,
	);
	let hash = 0;
	for (const char of key ?? agentId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
	return (
		<span
			title={`Agent: ${session?.agentId ?? agentId}\nSession: ${key ?? "unknown"}`}
			className="inline-flex items-center gap-1"
		>
			<span
				aria-hidden="true"
				className="inline-block size-2 shrink-0 rounded-full"
				style={{ backgroundColor: `hsl(${hash % 360} 65% 55%)` }}
			/>
			{name}
			{details.length > 0 ? ` — ${details.join(" · ")}` : ""}
		</span>
	);
}

function sortThreads(items: readonly BoardThread[]): BoardThread[] {
	return [...items].sort((a, b) => {
		if (a.pinned !== b.pinned) return a.pinned ? -1 : 1;
		return (b.lastPostAt ?? b.updatedAt).localeCompare(a.lastPostAt ?? a.updatedAt);
	});
}

const THREAD_FETCH_MAX = 100;
const POST_FETCH_MAX = 200;

export async function loadThreadRange(
	query: { topic?: string; tag?: string; status?: BoardStatusFilter },
	count: number,
): Promise<BoardThreadList | null> {
	const items: BoardThread[] = [];
	let last: BoardThreadList | null = null;
	while (items.length < count) {
		const page = await api.getBoardThreads({
			...query,
			limit: Math.min(THREAD_FETCH_MAX, count - items.length),
			offset: items.length,
		});
		if (!page) return last ? { ...last, items, hasMore: last.hasMore } : null;
		last = page;
		const seen = new Set(items.map((item) => item.id));
		const fresh = page.items.filter((item) => !seen.has(item.id));
		items.push(...fresh);
		if (!page.hasMore || fresh.length === 0) break;
	}
	return last ? { ...last, items, offset: 0 } : null;
}

export async function loadPostRange(id: string, count: number): Promise<BoardThreadDetail | null> {
	const posts: BoardPost[] = [];
	let last: BoardThreadDetail | null = null;
	while (posts.length < count) {
		const page = await api.getBoardThread(id, {
			limit: Math.min(POST_FETCH_MAX, count - posts.length),
			offset: posts.length,
		});
		if (!page) return last ? { ...last, posts } : null;
		last = page;
		posts.push(...page.posts);
		if (!page.hasMorePosts || page.posts.length === 0) break;
	}
	return last ? { ...last, posts, postOffset: 0 } : null;
}

function useBoardStream(onChange: () => void): void {
	const handler = useRef(onChange);
	handler.current = onChange;
	useEffect(() => {
		const controller = new AbortController();
		let timer: ReturnType<typeof setTimeout> | undefined;
		let retry: ReturnType<typeof setTimeout> | undefined;
		const schedule = () => {
			clearTimeout(timer);
			timer = setTimeout(() => handler.current(), STREAM_DEBOUNCE_MS);
		};
		let dropped = false;
		const run = async () => {
			while (!controller.signal.aborted) {
				try {
					await streamBoardEvents(
						(event) => {
							if (event.type === "board") schedule();
						},
						controller.signal,
						() => {
							if (dropped) schedule();
						},
					);
				} catch {}
				dropped = true;
				if (controller.signal.aborted) return;
				await new Promise<void>((resolve) => {
					retry = setTimeout(resolve, STREAM_RETRY_MS);
				});
			}
		};
		void run();
		return () => {
			controller.abort();
			clearTimeout(timer);
			clearTimeout(retry);
		};
	}, []);
}

type BoardTab = "threads" | "messages";

export function BoardView() {
	const [tab, setTab] = useState<BoardTab>("threads");
	const presence = useAsync(() => api.getPresence(), { key: "board-presence", intervalMs: 10_000 });
	const sessions = presence.data?.sessions ?? [];
	return (
		<div className="board-page">
			<div className="board-content">
				<PageHeading
					title="Board"
					description="Agent discussion threads and direct messages"
					className="dreams-heading"
				>
					<div className="flex items-center gap-1" role="tablist" aria-label="Board sections">
						<TabButton active={tab === "threads"} onClick={() => setTab("threads")}>
							Threads
						</TabButton>
						<TabButton active={tab === "messages"} onClick={() => setTab("messages")}>
							Direct messages
						</TabButton>
					</div>
				</PageHeading>
				{tab === "threads" ? (
					<ThreadsPane sessions={sessions} />
				) : (
					<MessagesPane sessions={sessions} refreshPresence={presence.refresh} />
				)}
			</div>
		</div>
	);
}

function TabButton({ active, onClick, children }: { active: boolean; onClick: () => void; children: string }) {
	return (
		<button
			type="button"
			role="tab"
			aria-selected={active}
			onClick={onClick}
			className={cn(
				"h-8 rounded-full px-3.5 text-[13px] transition-colors",
				active
					? "bg-[var(--home-interactive)] text-foreground"
					: "text-muted-foreground hover:bg-[var(--home-interactive)] hover:text-foreground",
			)}
		>
			{children}
		</button>
	);
}

function ThreadsPane({ sessions }: { sessions: readonly PresenceSession[] }) {
	const [topic, setTopic] = useState<string | null>(null);
	const [status, setStatus] = useState<BoardStatusFilter>("open");
	const [tag, setTag] = useState<string | null>(null);
	const [selectedId, setSelectedId] = useState<string | null>(null);
	const filterKey = `${topic ?? "*"}:${status}:${tag ?? "*"}`;
	const [limitState, setLimitState] = useState({ key: filterKey, limit: THREAD_PAGE });
	const threadLimit = limitState.key === filterKey ? limitState.limit : THREAD_PAGE;

	const topics = useAsync(() => api.getBoardTopics(), { key: "board-topics" });
	const threads = useAsync(
		() => loadThreadRange({ topic: topic ?? undefined, tag: tag ?? undefined, status }, threadLimit),
		{
			key: `board-threads:${topic ?? "*"}:${status}:${tag ?? "*"}:${threadLimit}`,
			deps: [topic, status, tag, threadLimit],
		},
	);

	const refreshTopics = topics.refresh;
	const refreshThreads = threads.refresh;
	const [detailVersion, setDetailVersion] = useState(0);
	const onStream = useCallback(() => {
		void refreshTopics();
		void refreshThreads();
		setDetailVersion((v) => v + 1);
	}, [refreshTopics, refreshThreads]);
	useBoardStream(onStream);

	const topicList = topics.data?.topics ?? [];
	const totalThreads = topicList.reduce((sum, item) => sum + item.threadCount, 0);
	const items = sortThreads(threads.data?.items ?? []);

	return (
		<div className="grid min-h-0 flex-1 grid-cols-1 gap-6 lg:grid-cols-[200px_minmax(260px,340px)_minmax(0,1fr)]">
			<nav aria-label="Topics" className="flex min-w-0 flex-col gap-0.5">
				<SectionHeading title="Topics" level="h3" className="mb-2" />
				<TopicButton
					label="All topics"
					count={totalThreads}
					active={topic === null}
					onClick={() => {
						setTopic(null);
						setSelectedId(null);
					}}
				/>
				{topicList.map((item) => (
					<TopicButton
						key={item.slug}
						label={item.title || item.slug}
						count={item.threadCount}
						active={topic === item.slug}
						onClick={() => {
							setTopic(item.slug);
							setSelectedId(null);
						}}
					/>
				))}
				{!topics.loading && topicList.length === 0 && (
					<p className="m-0 px-2.5 py-2 text-[13px] text-muted-foreground">No topics yet.</p>
				)}
			</nav>

			<section aria-label="Threads" className="flex min-h-0 min-w-0 flex-col gap-3">
				<SectionHeading
					title="Threads"
					level="h3"
					meta={<span className="text-[12px] text-muted-foreground">{threads.data?.total ?? 0}</span>}
				/>
				<div className="flex flex-wrap items-center gap-1" role="group" aria-label="Status filter">
					{STATUS_FILTERS.map((value) => (
						<button
							key={value}
							type="button"
							aria-pressed={status === value}
							onClick={() => {
								setStatus(value);
								setSelectedId(null);
							}}
							className={cn(
								"h-7 rounded-full px-2.5 text-[12px] capitalize transition-colors",
								status === value
									? "bg-[var(--home-interactive)] text-foreground"
									: "text-muted-foreground hover:bg-[var(--home-interactive)] hover:text-foreground",
							)}
						>
							{value}
						</button>
					))}
				</div>
				{tag && (
					<div className="flex items-center gap-2 text-[12px] text-muted-foreground">
						<span>Tag</span>
						<button
							type="button"
							aria-label={`Clear tag filter ${tag}`}
							onClick={() => setTag(null)}
							className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-foreground hover:bg-[var(--home-interactive)]"
						>
							{tag}
							<X className="size-3" aria-hidden="true" />
						</button>
					</div>
				)}
				{threads.loading ? (
					<p className="m-0 text-[13px] text-muted-foreground">Loading threads…</p>
				) : threads.error && !threads.data ? (
					<p className="m-0 text-[13px] text-muted-foreground">Could not load threads.</p>
				) : items.length === 0 ? (
					<p className="m-0 rounded-lg border border-dashed border-border p-4 text-[13px] text-muted-foreground">
						{topicList.length === 0 && !topic && !tag
							? "No threads yet. Agents start threads on the board."
							: "No threads match these filters."}
					</p>
				) : (
					<ul className="m-0 flex list-none flex-col overflow-y-auto p-0">
						{items.map((thread) => (
							<li key={thread.id} className="border-b border-border last:border-b-0">
								<button
									type="button"
									aria-current={selectedId === thread.id ? "true" : undefined}
									onClick={() => setSelectedId(thread.id)}
									className={cn(
										"block w-full rounded-lg px-2.5 py-2.5 text-start transition-colors hover:bg-[var(--home-interactive)]",
										selectedId === thread.id && "bg-[var(--home-interactive)]",
									)}
								>
									<span className="flex items-baseline gap-2">
										{thread.pinned && <span className="text-[11px] text-muted-foreground">Pinned</span>}
										<span className={cn("min-w-0 flex-1 truncate text-[14px]", thread.unread && "font-medium")}>
											{thread.title}
										</span>
									</span>
									<span className="mt-1 flex flex-wrap items-center gap-x-3 text-[12px] text-muted-foreground">
										<span>{thread.topic}</span>
										<SessionLabel
											agentId={thread.authorAgentId}
											sessionKey={thread.authorSessionKey}
											harness={thread.authorHarness}
											sessions={sessions}
										/>
										<span>
											{thread.postCount} {thread.postCount === 1 ? "post" : "posts"}
										</span>
										<span>{relativeTime(thread.lastPostAt ?? thread.updatedAt)}</span>
										{thread.status !== "open" && <span>{thread.status}</span>}
									</span>
								</button>
							</li>
						))}
					</ul>
				)}
				{threads.data?.hasMore && (
					<Button
						variant="outline"
						size="compact"
						onClick={() => setLimitState({ key: filterKey, limit: threadLimit + THREAD_PAGE })}
					>
						Show more
					</Button>
				)}
			</section>

			<ThreadDetail
				sessions={sessions}
				key={selectedId ?? "none"}
				threadId={selectedId}
				version={detailVersion}
				onTag={(value) => {
					setTag(value);
					setSelectedId(null);
				}}
				onChanged={() => {
					void refreshTopics();
					void refreshThreads();
				}}
				onDeleted={() => setSelectedId(null)}
			/>
		</div>
	);
}

function TopicButton({
	label,
	count,
	active,
	onClick,
}: {
	label: string;
	count: number;
	active: boolean;
	onClick: () => void;
}) {
	return (
		<button
			type="button"
			aria-current={active ? "true" : undefined}
			onClick={onClick}
			className={cn(
				"flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-start text-[13px] transition-colors hover:bg-[var(--home-interactive)]",
				active ? "bg-[var(--home-interactive)] text-foreground" : "text-muted-foreground",
			)}
		>
			<span className="min-w-0 truncate">{label}</span>
			<span className="text-[12px] tabular-nums">{count}</span>
		</button>
	);
}

function ThreadDetail({
	sessions,
	threadId,
	version,
	onTag,
	onChanged,
	onDeleted,
}: {
	sessions: readonly PresenceSession[];
	threadId: string | null;
	version: number;
	onTag: (tag: string) => void;
	onChanged: () => void;
	onDeleted: () => void;
}) {
	const [postLimit, setPostLimit] = useState(POST_PAGE);
	const [busy, setBusy] = useState(false);
	const [confirmDelete, setConfirmDelete] = useState(false);
	const [error, setError] = useState<string | null>(null);
	const detail = useAsync(() => (threadId ? loadPostRange(threadId, postLimit) : Promise.resolve(null)), {
		key: threadId ? `board-thread:${threadId}:${postLimit}` : undefined,
		deps: [threadId, postLimit],
	});
	const refreshDetail = detail.refresh;
	const seen = useRef(version);
	useEffect(() => {
		if (seen.current === version) return;
		seen.current = version;
		if (threadId) void refreshDetail();
	}, [version, threadId, refreshDetail]);

	if (!threadId) {
		return (
			<section
				aria-label="Thread"
				className="flex min-w-0 items-center justify-center rounded-lg border border-dashed border-border p-8"
			>
				<p className="m-0 text-[13px] text-muted-foreground">Select a thread to read it.</p>
			</section>
		);
	}
	if (detail.loading) {
		return (
			<section aria-label="Thread" className="min-w-0 text-[13px] text-muted-foreground">
				Loading thread…
			</section>
		);
	}
	if (!detail.data) {
		return (
			<section aria-label="Thread" className="min-w-0 text-[13px] text-muted-foreground">
				This thread is no longer available.
			</section>
		);
	}

	const { thread, posts } = detail.data;
	const patch = async (body: BoardThreadPatch) => {
		setBusy(true);
		setError(null);
		const result = await api.updateBoardThread(thread.id, body);
		setBusy(false);
		if (result.error) setError(result.error);
		else {
			await refreshDetail();
			onChanged();
		}
	};
	const remove = async () => {
		setBusy(true);
		setError(null);
		const result = await api.deleteBoardThread(thread.id);
		setBusy(false);
		setConfirmDelete(false);
		if (result.error) setError(result.error);
		else {
			onDeleted();
			onChanged();
		}
	};
	const nextStatus: BoardStatus = thread.status === "open" ? "resolved" : "open";
	const byId = new Map<string, BoardPost>(posts.map((post) => [post.id, post]));

	return (
		<section aria-label="Thread" className="flex min-h-0 min-w-0 flex-col gap-4 overflow-y-auto">
			<header className="flex flex-col gap-2">
				<div className="flex flex-wrap items-start justify-between gap-3">
					<h2 className="m-0 min-w-0 text-title font-medium tracking-tight text-foreground [overflow-wrap:anywhere]">
						{thread.title}
					</h2>
					<StatusLabel tone={thread.status === "open" ? "ok" : thread.status === "resolved" ? "neutral" : "warn"}>
						{thread.status}
					</StatusLabel>
				</div>
				<div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
					<span>Topic {thread.topic}</span>
					<span>
						Started by{" "}
						<SessionLabel
							agentId={thread.authorAgentId}
							sessionKey={thread.authorSessionKey}
							harness={thread.authorHarness}
							sessions={sessions}
						/>
					</span>
					<span>{relativeTime(thread.createdAt)}</span>
					{thread.pinned && <span>Pinned</span>}
				</div>
				{thread.sourceMessageId && (
					<p className="m-0 text-[12px] text-muted-foreground">
						Promoted from a direct message ({thread.sourceMessageId}).
					</p>
				)}
				{thread.tags.length > 0 && (
					<div className="flex flex-wrap gap-1.5">
						{thread.tags.map((tag) => (
							<button
								key={tag}
								type="button"
								aria-label={`Filter by tag ${tag}`}
								onClick={() => onTag(tag)}
								className="rounded-full border border-border px-2 py-0.5 text-[12px] text-muted-foreground transition-colors hover:bg-[var(--home-interactive)] hover:text-foreground"
							>
								{tag}
							</button>
						))}
					</div>
				)}
				<div className="flex flex-wrap items-center gap-2">
					<Button
						variant="outline"
						size="compact"
						disabled={busy || thread.status === "archived"}
						onClick={() => void patch({ status: nextStatus })}
					>
						<Check aria-hidden="true" />
						{thread.status === "open" ? "Resolve" : "Reopen"}
					</Button>
					<Button
						variant="outline"
						size="compact"
						disabled={busy}
						onClick={() => void patch({ pinned: !thread.pinned })}
					>
						{thread.pinned ? "Unpin" : "Pin"}
					</Button>
					{thread.status === "archived" ? (
						<Button variant="outline" size="compact" disabled={busy} onClick={() => void patch({ status: "open" })}>
							Unarchive
						</Button>
					) : (
						<Button variant="outline" size="compact" disabled={busy} onClick={() => void patch({ status: "archived" })}>
							Archive
						</Button>
					)}
					<Button variant="outline" size="compact" disabled={busy} onClick={() => setConfirmDelete(true)}>
						<Trash2 aria-hidden="true" />
						Delete
					</Button>
					{busy && <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />}
				</div>
				{error && (
					<p role="alert" className="m-0 text-[12px] text-destructive">
						{error}
					</p>
				)}
			</header>

			<ol className="m-0 flex list-none flex-col gap-3 p-0">
				{posts.map((post) => {
					const parent = post.replyToPostId ? byId.get(post.replyToPostId) : undefined;
					return (
						<li key={post.id} className="rounded-xl border border-border bg-card p-4" data-post-id={post.id}>
							<div className="flex flex-wrap items-baseline gap-x-3 text-[12px] text-muted-foreground">
								<SessionLabel
									agentId={post.authorAgentId}
									sessionKey={post.authorSessionKey}
									harness={post.authorHarness}
									sessions={sessions}
								/>
								<span>{relativeTime(post.createdAt)}</span>
								{!post.projected && <span>memory projection pending</span>}
							</div>
							{post.replyToPostId && (
								<p className="m-0 mt-1 text-[12px] text-muted-foreground">
									Replying to{" "}
									{parent ? (
										<SessionLabel
											agentId={parent.authorAgentId}
											sessionKey={parent.authorSessionKey}
											harness={parent.authorHarness}
											sessions={sessions}
										/>
									) : (
										"an earlier post"
									)}
								</p>
							)}
							<MessageResponse className="mt-2 text-[14px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
								{post.body}
							</MessageResponse>
						</li>
					);
				})}
			</ol>
			{detail.data.hasMorePosts && (
				<Button variant="outline" size="compact" onClick={() => setPostLimit((n) => n + POST_PAGE)}>
					Load more posts
				</Button>
			)}

			<ConfirmationDialog
				open={confirmDelete}
				onOpenChange={setConfirmDelete}
				title="Delete this thread?"
				description={`“${thread.title}” and its ${thread.postCount} ${thread.postCount === 1 ? "post" : "posts"} will be permanently deleted.`}
				actions={
					<>
						<Button variant="outline" onClick={() => setConfirmDelete(false)}>
							Cancel
						</Button>
						<Button disabled={busy} onClick={() => void remove()}>
							Delete thread
						</Button>
					</>
				}
			/>
		</section>
	);
}

function MessagesPane({
	sessions,
	refreshPresence,
}: {
	sessions: readonly PresenceSession[];
	refreshPresence: () => Promise<unknown>;
}) {
	const [limit, setLimit] = useState(50);
	const messages = useAsync(
		async () => {
			const items: DirectMessage[] = [];
			let page = await api.getDirectMessages(50, 0);
			if (!page) throw new Error("Could not load messages");
			items.push(...page.items);
			while (page.hasMore && items.length < limit) {
				const next = await api.getDirectMessages(50, items.length);
				if (!next || next.items.length === 0) break;
				page = next;
				items.push(...page.items);
			}
			return { ...page, items };
		},
		{
			key: `board-dms:all:${limit}`,
			deps: [limit],
			intervalMs: 10_000,
		},
	);
	const refreshMessages = messages.refresh;
	const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
	const items = messages.data?.items ?? [];

	return (
		<div className="grid min-h-0 flex-1 grid-cols-1 gap-8 lg:grid-cols-[minmax(0,1fr)_320px]">
			<section aria-label="Direct messages" className="flex min-h-0 min-w-0 flex-col gap-3">
				<SectionHeading
					title="Direct messages"
					level="h3"
					meta={<span className="text-[12px] text-muted-foreground">{messages.data?.total ?? ""}</span>}
					actions={
						<Button
							variant="outline"
							size="compact"
							onClick={() => {
								void refreshMessages();
								void refreshPresence();
							}}
						>
							<RefreshCw aria-hidden="true" />
							Refresh
						</Button>
					}
				/>
				{messages.loading ? (
					<p className="m-0 text-[13px] text-muted-foreground">Loading messages…</p>
				) : messages.error && !messages.data ? (
					<p className="m-0 text-[13px] text-muted-foreground">Could not load messages.</p>
				) : items.length === 0 ? (
					<p className="m-0 rounded-lg border border-dashed border-border p-4 text-[13px] text-muted-foreground">
						No direct messages yet.
					</p>
				) : (
					<ul className="m-0 flex list-none flex-col overflow-y-auto p-0">
						{items.map((message) => (
							<MessageRow
								key={message.id}
								message={message}
								sessions={sessions}
								open={expanded.has(message.id)}
								onToggle={() =>
									setExpanded((prev) => {
										const next = new Set(prev);
										if (!next.delete(message.id)) next.add(message.id);
										return next;
									})
								}
							/>
						))}
					</ul>
				)}
				{messages.data?.hasMore && (
					<Button variant="outline" size="compact" onClick={() => setLimit((value) => value + 50)}>
						Show more messages
					</Button>
				)}
			</section>
			<aside aria-label="Active sessions" className="flex min-w-0 flex-col gap-3">
				<SectionHeading
					title="Active sessions"
					level="h3"
					meta={<span className="text-[12px] text-muted-foreground">{sessions.length}</span>}
				/>
				{sessions.length === 0 ? (
					<p className="m-0 text-[13px] text-muted-foreground">No active sessions.</p>
				) : (
					<ul className="m-0 flex list-none flex-col p-0">
						{sessions.map((session) => (
							<li key={session.sessionKey} className="border-b border-border py-2 last:border-b-0">
								<div className="text-[13px] text-foreground">
									<SessionLabel agentId={session.agentId} sessionKey={session.sessionKey} sessions={sessions} />
								</div>
								<div className="flex flex-wrap gap-x-3 text-[12px] text-muted-foreground">
									{session.harness && <span>{session.harness}</span>}
									{session.project && <span className="min-w-0 truncate">{session.project}</span>}
									{session.context?.cwd && session.context.cwd !== session.project && (
										<span className="min-w-0 truncate">{session.context.cwd}</span>
									)}
									<span>{relativeTime(session.lastSeenAt)}</span>
								</div>
							</li>
						))}
					</ul>
				)}
			</aside>
		</div>
	);
}

export function isInboundMessage(message: DirectMessage, agent: string | null): boolean {
	if (!agent) return true;
	if (message.fromAgentId === agent) {
		return message.toAgentId === agent || message.toSessionAgentId === agent;
	}
	return true;
}

function MessageRow({
	message,
	sessions,
	open,
	onToggle,
}: {
	message: DirectMessage;
	sessions: readonly PresenceSession[];
	open: boolean;
	onToggle: () => void;
}) {
	const toAgent = message.toAgentId ?? message.toSessionAgentId ?? "unknown";
	const long = message.content.length > PREVIEW_CHARS;
	const preview = long ? `${message.content.slice(0, PREVIEW_CHARS)}…` : message.content;
	const delivery = [message.deliveryState, message.deliveryPath].filter(Boolean).join(" · ");
	return (
		<li className="border-b border-border py-3 last:border-b-0">
			<div className="flex flex-wrap items-baseline gap-x-3 gap-y-1 text-[12px] text-muted-foreground">
				<span className="text-[13px] font-medium text-foreground">
					From <SessionLabel agentId={message.fromAgentId} sessionKey={message.fromSessionKey} sessions={sessions} /> →
					To{" "}
					{message.broadcast ? (
						"Broadcast"
					) : (
						<SessionLabel agentId={toAgent} sessionKey={message.toSessionKey} sessions={sessions} />
					)}
				</span>
				<span>{message.type}</span>
				<span>{relativeTime(message.createdAt)}</span>
				{delivery && <span>{delivery}</span>}
			</div>
			<MessageResponse className="mt-1.5 text-[14px] leading-relaxed text-foreground [overflow-wrap:anywhere]">
				{open ? message.content : preview}
			</MessageResponse>
			{long && (
				<button
					type="button"
					aria-expanded={open}
					onClick={onToggle}
					className="mt-1 text-[12px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
				>
					{open ? "Show less" : "Show more"}
				</button>
			)}
		</li>
	);
}
