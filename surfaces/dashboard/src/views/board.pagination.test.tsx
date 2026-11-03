import { afterEach, expect, spyOn, test } from "bun:test";
import { Window } from "happy-dom";
import { installDashboardDomGlobals } from "@/test/dom-globals";
import type { DirectMessage } from "@/lib/api";

const restore = installDashboardDomGlobals(new Window({ url: "http://localhost/#" }));
const { isInboundMessage, loadPostRange, loadThreadRange } = await import("./board");

afterEach(() => {
	spyOn(globalThis, "fetch").mockRestore();
});

function thread(id: string) {
	return { id, topic: "t", title: id, status: "open", pinned: false, tags: [], postCount: 0 };
}

test("loadThreadRange pages with offset and clamps per-request limit", async () => {
	const urls: string[] = [];
	spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
		const url = new URL(String(input), "http://localhost");
		urls.push(url.search);
		const limit = Number(url.searchParams.get("limit"));
		const offset = Number(url.searchParams.get("offset"));
		const items = Array.from({ length: Math.min(limit, 100) }, (_, i) => thread(`t${offset + i}`));
		return Response.json({ items, total: 500, limit, offset, hasMore: offset + items.length < 500 });
	}) as typeof fetch);
	const result = await loadThreadRange({}, 150);
	expect(result?.items.length).toBe(150);
	expect(new Set(result?.items.map((t) => t.id)).size).toBe(150);
	expect(urls.map((u) => new URLSearchParams(u).get("offset"))).toEqual(["0", "100"]);
	expect(result?.hasMore).toBe(true);
});

test("loadPostRange sends offset and accumulates posts", async () => {
	const offsets: string[] = [];
	spyOn(globalThis, "fetch").mockImplementation((async (input: RequestInfo | URL) => {
		const url = new URL(String(input), "http://localhost");
		const limit = Number(url.searchParams.get("limit"));
		const offset = Number(url.searchParams.get("offset"));
		offsets.push(String(offset));
		const posts = Array.from({ length: Math.min(limit, 200) }, (_, i) => ({ id: `p${offset + i}` }));
		return Response.json({
			thread: { id: "t1" },
			posts,
			postTotal: 450,
			postLimit: limit,
			postOffset: offset,
			hasMorePosts: offset + posts.length < 450,
		});
	}) as typeof fetch);
	const result = await loadPostRange("t1", 400);
	expect(result?.posts.length).toBe(400);
	expect(new Set(result?.posts.map((p) => p.id)).size).toBe(400);
	expect(offsets).toEqual(["0", "200"]);
});

function msg(over: Partial<DirectMessage>): DirectMessage {
	return {
		id: "m",
		createdAt: "",
		expiresAt: null,
		fromAgentId: "alpha",
		fromSessionKey: null,
		toAgentId: "beta",
		toSessionKey: null,
		content: "",
		type: "info",
		broadcast: false,
		deliveryPath: null,
		deliveryState: null,
		acknowledgedAt: null,
		...over,
	};
}

test("sent-only rows are not inbound; received, broadcast and self rows are", () => {
	expect(isInboundMessage(msg({}), "alpha")).toBe(false);
	expect(isInboundMessage(msg({ fromAgentId: "beta", toAgentId: "alpha" }), "alpha")).toBe(true);
	expect(isInboundMessage(msg({ fromAgentId: "beta", toAgentId: null, broadcast: true }), "alpha")).toBe(true);
	expect(isInboundMessage(msg({ toAgentId: "alpha" }), "alpha")).toBe(true);
	expect(isInboundMessage(msg({ toAgentId: null, toSessionAgentId: "alpha" }), "alpha")).toBe(true);
	expect(isInboundMessage(msg({ toAgentId: null, broadcast: true }), "alpha")).toBe(false);
});

test("cleanup", () => restore());
