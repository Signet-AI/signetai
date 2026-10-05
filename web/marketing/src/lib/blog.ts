import { type CollectionEntry, getCollection } from "astro:content";
import type { CoverMotif, CoverTone } from "./cover-field";

export type Post = CollectionEntry<"blog">;
export type Category = Post["data"]["category"];

const WORDS_PER_MINUTE = 230;

export const CATEGORIES: Record<Category, { readonly label: string; readonly plural: string }> = {
	announcement: { label: "Announcement", plural: "Announcements" },
	engineering: { label: "Engineering", plural: "Engineering" },
	essay: { label: "Essay", plural: "Essays" },
	guide: { label: "Guide", plural: "Guides" },
};

const MOTIFS: Record<Category, readonly CoverMotif[]> = {
	announcement: ["burst"],
	engineering: ["lattice"],
	essay: ["ridges", "orbit", "tide"],
	guide: ["path"],
};

const TONES: readonly CoverTone[] = ["night", "paper", "dusk"];
export const COVER_SIZES = { card: [960, 540], full: [1600, 900], wide: [1600, 600] } as const;
export type CoverSize = keyof typeof COVER_SIZES;
export async function getPosts(): Promise<Post[]> {
	const posts = await getCollection("blog", (post) => import.meta.env.DEV || !post.data.draft);
	return posts.sort((a, b) => b.data.date.getTime() - a.data.date.getTime() || b.id.localeCompare(a.id));
}

export function postUrl(post: Post): string {
	return `/blog/${post.id}/`;
}

export function coverUrl(post: Post, size: CoverSize): string {
	return `/blog/cover/${size}/${post.id}.webp`;
}
function issue(post: Post, posts: readonly Post[]): number {
	return posts.length - posts.findIndex((p) => p.id === post.id);
}

export function issueNumber(post: Post, posts: readonly Post[]): string {
	return String(issue(post, posts)).padStart(3, "0");
}
export function coverStyle(post: Post, posts: readonly Post[]): { motif: CoverMotif; tone: CoverTone } {
	const n = issue(post, posts);
	const motifs = MOTIFS[post.data.category];
	const motif = motifs[n % motifs.length] ?? "ridges";
	if (post.data.category === "announcement") return { motif, tone: "electric" };
	return { motif, tone: TONES[(n + Math.floor(n / 3)) % TONES.length] ?? "night" };
}
export function formatDate(date: Date): string {
	return date.toLocaleDateString("en-US", {
		year: "numeric",
		month: "short",
		day: "numeric",
		timeZone: "UTC",
	});
}

export function isoDate(date: Date): string {
	return date.toISOString().slice(0, 10);
}

export function readingMinutes(post: Post): number {
	const words = (post.body ?? "").split(/\s+/).filter(Boolean).length;
	return Math.max(1, Math.round(words / WORDS_PER_MINUTE));
}
