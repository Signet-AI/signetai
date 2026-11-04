import { dashboardQueryCache } from "@/lib/query-cache";
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { act } from "react";
import type { Root } from "react-dom/client";
import { installDashboardDomGlobals } from "@/test/dom-globals";
let createRoot: typeof import("react-dom/client").createRoot;
let BoardView: typeof import("./board").BoardView;

beforeEach(() => dashboardQueryCache.clear(false, false));

const dom = new Window({ url: "http://localhost/#" });
const originalFetch = globalThis.fetch;
let restoreDomGlobals = () => {};
const calls: Array<{ method: string; url: string; body: string | null }> = [];

const THREAD = {
	id: "t1",
	topic: "engineering",
	title: "Release checklist",
	authorAgentId: "alpha",
	authorSessionKey: "sess-alpha-0001-long-key",
	authorHarness: "claude-code",
	status: "open",
	pinned: false,
	tags: ["release"],
	sourceMessageId: "msg-9",
	postCount: 2,
	createdAt: "2026-10-05T08:00:00.000Z",
	updatedAt: "2026-10-05T09:00:00.000Z",
	lastPostAt: "2026-10-05T09:00:00.000Z",
	lastReadAt: null,
	unread: true,
};
const OTHER = { ...THREAD, id: "t2", topic: "research", title: "Recall notes", tags: [], sourceMessageId: null };
const POSTS = [
	{
		id: "p1",
		threadId: "t1",
		authorAgentId: "alpha",
		authorSessionKey: null,
		authorHarness: "claude-code",
		body: "<img src=x onerror=alert(1)> first post",
		replyToPostId: null,
		createdAt: "2026-10-05T08:00:00.000Z",
		projected: false,
	},
	{
		id: "p2",
		threadId: "t1",
		authorAgentId: "beta",
		authorSessionKey: null,
		authorHarness: "codex",
		body: "second **bold** post with `code`",
		replyToPostId: "p1",
		createdAt: "2026-10-05T09:00:00.000Z",
		projected: false,
	},
];
const LONG = "x".repeat(300);
const MESSAGES = [
	{
		id: "m1",
		createdAt: "2026-10-05T09:00:00.000Z",
		expiresAt: null,
		fromAgentId: "alpha",
		fromSessionKey: "session-alpha",
		toAgentId: "beta",
		toSessionKey: "session-beta",
		content: `**hello** with \`code\` ${LONG}`,
		type: "question",
		broadcast: false,
		deliveryPath: "wake",
		deliveryState: "delivered",
		acknowledgedAt: null,
	},
	{
		id: "m2",
		createdAt: "2026-10-05T09:00:00.000Z",
		expiresAt: null,
		fromAgentId: "unseen-agent-123456",
		fromSessionKey: null,
		toAgentId: "unknown-target",
		toSessionKey: null,
		content: "Fallback",
		type: "info",
		broadcast: false,
		deliveryPath: null,
		deliveryState: null,
		acknowledgedAt: null,
	},
];

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

beforeAll(async () => {
	restoreDomGlobals = installDashboardDomGlobals(dom);
	({ createRoot } = await import("react-dom/client"));
	({ BoardView } = await import("./board"));
	globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
		const url = String(input);
		const method = init?.method ?? "GET";
		calls.push({ method, url, body: typeof init?.body === "string" ? init.body : null });
		if (url.includes("/api/board/stream")) return new Response("no", { status: 404 });
		if (url.includes("/api/board/topics")) {
			return Response.json({
				topics: [
					{
						slug: "engineering",
						title: "Engineering",
						description: null,
						createdByAgentId: null,
						createdAt: "",
						updatedAt: "",
						threadCount: 1,
						lastActivityAt: null,
					},
					{
						slug: "research",
						title: "Research",
						description: null,
						createdByAgentId: null,
						createdAt: "",
						updatedAt: "",
						threadCount: 1,
						lastActivityAt: null,
					},
				],
				count: 2,
			});
		}
		if (url.includes("/api/board/threads/t1")) {
			if (method === "PATCH") return Response.json({ thread: { ...THREAD, status: "resolved" } });
			if (method === "DELETE") return Response.json({ threadId: "t1", deletedPosts: 2 });
			return Response.json({
				thread: THREAD,
				posts: POSTS,
				postTotal: 2,
				postLimit: 200,
				postOffset: 0,
				hasMorePosts: false,
			});
		}
		if (url.includes("/api/board/threads")) {
			const topic = new URL(url, "http://localhost").searchParams.get("topic");
			const items = topic === "research" ? [OTHER] : topic === "engineering" ? [THREAD] : [OTHER, THREAD];
			return Response.json({ items, total: items.length, limit: 50, offset: 0, hasMore: false });
		}
		if (url.includes("/api/cross-agent/messages")) {
			return Response.json({ items: MESSAGES, total: 2, unreadCount: 1, hasMore: false });
		}
		if (url.includes("/api/cross-agent/presence")) {
			return Response.json({
				sessions: [
					{
						sessionKey: "session-beta",
						agentId: "beta",
						harness: "pi",
						project: "/repo/other",
						context: { title: "Builder" },
						lastSeenAt: "2026-10-05T09:00:00.000Z",
					},
					{
						sessionKey: "session-alpha",
						agentId: "alpha",
						harness: "pi",
						project: "/repo/project",
						context: { task: "Fix issue", title: "Reviewer" },
						lastSeenAt: "2026-10-05T09:00:00.000Z",
					},
					{
						sessionKey: "s1",
						agentId: "gamma",
						harness: "opencode",
						project: "/proj",
						lastSeenAt: "2026-10-05T09:00:00.000Z",
					},
				],
			});
		}
		if (url.endsWith("/api/status")) return Response.json({ agentId: "alpha" });
		return new Response("not found", { status: 404 });
	}) as typeof fetch;
});

afterAll(async () => {
	await new Promise((resolve) => setTimeout(resolve, 10));
	globalThis.fetch = originalFetch;
	restoreDomGlobals();
});

async function render(): Promise<[HTMLElement, Root]> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(<BoardView />);
		await flush();
		await flush();
	});
	return [container, root];
}

async function click(el: Element | null | undefined): Promise<void> {
	expect(el).toBeTruthy();
	await act(async () => {
		(el as HTMLElement).click();
		await flush();
		await flush();
	});
}

function button(container: ParentNode, text: string): HTMLButtonElement | undefined {
	return [...container.querySelectorAll("button")].find((b) => b.textContent?.trim() === text);
}

async function cleanup(root: Root, container: HTMLElement): Promise<void> {
	await act(async () => root.unmount());
	container.remove();
}

describe("board view", () => {
	test("lists topics, filters threads, and safely renders Markdown", async () => {
		const [container, root] = await render();
		try {
			expect(container.querySelector('nav[aria-label="Topics"]')?.textContent).toContain("All topics");
			expect(container.textContent).toContain("Recall notes");
			expect(container.textContent).toContain("Release checklist");
			await click(button(container.querySelector('nav[aria-label="Topics"]') as HTMLElement, "Research1"));
			expect(container.querySelector('section[aria-label="Threads"]')?.textContent).not.toContain("Release checklist");
			await click(button(container.querySelector('nav[aria-label="Topics"]') as HTMLElement, "All topics2"));
			const row = [...container.querySelectorAll('section[aria-label="Threads"] li button')].find((b) =>
				b.textContent?.includes("Release checklist"),
			);
			await click(row);
			const detail = container.querySelector('section[aria-label="Thread"]');
			expect(detail?.textContent).toContain("Started by alpha · claude-code · #ng-key");
			expect(detail?.textContent).toContain("Promoted from a direct message (msg-9)");
			expect(detail?.textContent).toContain("Replying to alpha · pi · project · #-alpha");
			expect(detail?.querySelector('[data-streamdown="strong"]')?.textContent).toBe("bold");
			expect(detail?.querySelector("code")?.textContent).toBe("code");
			expect(detail?.querySelector("img")).toBeNull();
			expect(detail?.textContent).toContain("first post");
		} finally {
			await cleanup(root, container);
		}
	});

	test("resolve sends PATCH with scope all", async () => {
		calls.length = 0;
		const [container, root] = await render();
		try {
			await click(
				[...container.querySelectorAll('section[aria-label="Threads"] li button')].find((b) =>
					b.textContent?.includes("Release checklist"),
				),
			);
			await click(button(container, "Resolve"));
			const patch = calls.find((c) => c.method === "PATCH");
			expect(patch?.url).toContain("/api/board/threads/t1");
			expect(JSON.parse(patch?.body ?? "{}")).toEqual({ scope: "all", status: "resolved" });
			expect(
				calls
					.filter((c) => c.url.includes("/api/board/threads") && c.method === "GET")
					.every((c) => c.url.includes("scope=all")),
			).toBe(true);
		} finally {
			await cleanup(root, container);
		}
	});

	test("delete requires confirmation and sends DELETE with scope all", async () => {
		calls.length = 0;
		const [container, root] = await render();
		try {
			await click(
				[...container.querySelectorAll('section[aria-label="Threads"] li button')].find((b) =>
					b.textContent?.includes("Release checklist"),
				),
			);
			await click(button(container, "Delete"));
			expect(calls.some((c) => c.method === "DELETE")).toBe(false);
			expect(document.querySelector('[role="dialog"]')?.textContent).toContain("Delete this thread?");
			await click(button(document.body, "Delete thread"));
			const del = calls.find((c) => c.method === "DELETE");
			expect(del?.url).toContain("/api/board/threads/t1");
			expect(del?.url).toContain("scope=all");
		} finally {
			await cleanup(root, container);
		}
	});

	test("clicking a tag chip filters threads by tag", async () => {
		calls.length = 0;
		const [container, root] = await render();
		try {
			await click(
				[...container.querySelectorAll('section[aria-label="Threads"] li button')].find((b) =>
					b.textContent?.includes("Release checklist"),
				),
			);
			await click(container.querySelector('button[aria-label="Filter by tag release"]'));
			expect(calls.some((c) => c.url.includes("tag=release"))).toBe(true);
			expect(container.querySelector('button[aria-label="Clear tag filter release"]')).toBeTruthy();
		} finally {
			await cleanup(root, container);
		}
	});

	test("direct messages tab lists messages, delivery state, expandable content, and sessions", async () => {
		calls.length = 0;
		const [container, root] = await render();
		try {
			await click(button(container, "Direct messages"));
			expect(calls.some((c) => c.url.includes("/api/cross-agent/messages?scope=all"))).toBe(true);
			const list = container.querySelector('section[aria-label="Direct messages"]');
			expect(list?.textContent).toContain(
				"From alpha · pi · project · #-alpha — Reviewer · Fix issue → To beta · pi · other · #n-beta — Builder",
			);
			expect(list?.querySelector("[title*=session-alpha]")).toBeTruthy();
			expect(list?.textContent).toContain("From unseen-agent-123456 → To unknown-target");
			expect(list?.querySelector('[data-streamdown="strong"]')?.textContent).toBe("hello");
			expect(list?.querySelector("code")?.textContent).toBe("code");
			expect(list?.textContent).toContain("question");
			expect(list?.textContent).not.toContain("Unread");
			expect(list?.textContent).toContain("delivered · wake");
			expect(list?.textContent).not.toContain(LONG);
			await click(button(container, "Show more"));
			expect(container.querySelector('section[aria-label="Direct messages"]')?.textContent).toContain(LONG);
			expect(container.querySelector('aside[aria-label="Active sessions"]')?.textContent).toContain(
				"gamma · opencode · proj · #s1",
			);
		} finally {
			await cleanup(root, container);
		}
	});
});
