import type { CollectionEntry } from "astro:content";

export const SECTION_ORDER = [
	"Getting Started",
	"Core Concepts",
	"Reference",
	"Infrastructure",
	"Features",
	"Project",
	"Specs",
] as const;

export interface DocNavItem {
	readonly title: string;
	readonly description?: string;
	readonly section: string;
	readonly order: number;
	readonly slug: string;
	readonly url: string;
}

export interface DocNavSection {
	readonly label: string;
	readonly items: readonly DocNavItem[];
}

function sectionRank(section: string): number {
	const index = SECTION_ORDER.indexOf(section as (typeof SECTION_ORDER)[number]);
	return index >= 0 ? index : SECTION_ORDER.length;
}

export function toSlug(id: string): string {
	return id.replace(/\.md$/, "").toLowerCase();
}

export function buildDocsNav(docs: readonly CollectionEntry<"docs">[]): {
	readonly flat: readonly DocNavItem[];
	readonly sections: readonly DocNavSection[];
} {
	const flat = docs
		.map((doc) => {
			const slug = toSlug(doc.id);
			const section = slug.startsWith("specs/") ? "Specs" : (doc.data.section ?? "Other");

			return {
				title: doc.data.title,
				description: doc.data.description,
				section,
				order: doc.data.order ?? 999,
				slug,
				url: `/docs/${slug}`,
			};
		})
		.sort((a, b) => {
			const sectionDiff = sectionRank(a.section) - sectionRank(b.section);
			if (sectionDiff !== 0) return sectionDiff;

			const orderDiff = a.order - b.order;
			if (orderDiff !== 0) return orderDiff;

			return a.title.localeCompare(b.title);
		});

	const grouped = new Map<string, DocNavItem[]>();
	for (const doc of flat) {
		const existing = grouped.get(doc.section);
		if (existing) {
			existing.push(doc);
			continue;
		}
		grouped.set(doc.section, [doc]);
	}

	const sections: DocNavSection[] = [];
	for (const label of SECTION_ORDER) {
		const items = grouped.get(label);
		if (items) {
			sections.push({ label, items });
			grouped.delete(label);
		}
	}

	for (const [label, items] of grouped) {
		sections.push({ label, items });
	}

	return { flat, sections };
}

export function getDocNeighbors(
	docs: readonly DocNavItem[],
	currentSlug?: string,
): {
	readonly previous?: DocNavItem;
	readonly next?: DocNavItem;
} {
	if (!currentSlug) return {};

	const index = docs.findIndex((doc) => doc.slug === currentSlug);
	if (index < 0) return {};

	const previous = index > 0 ? docs[index - 1] : undefined;
	const next = index < docs.length - 1 ? docs[index + 1] : undefined;

	return { previous, next };
}
