// Masonry layout for blog cards using pretext for height prediction.
// Assigns CSS order values for balanced CSS multi-column layout.
// Degrades gracefully: without JS, cards render in natural order.

import { layoutText, prepareText, resolveSiteFont } from "./pretext-utils";

const CARD_PADDING = 48; // vertical padding inside card
const IMAGE_HEIGHT = 160; // approximate image block height (aspect 2:1 at ~320px col)
const DATE_HEIGHT = 20;
const TAGS_HEIGHT = 28;
const GAP = 0; // CSS column-gap handles spacing

type CardMeasurement = {
	el: HTMLElement;
	height: number;
};

async function measureCards(cards: HTMLElement[], colWidth: number): Promise<CardMeasurement[]> {
	const titleFont = resolveSiteFont("display", 18, 600);
	const descFont = resolveSiteFont("mono", 14, 400);
	const textWidth = colWidth - 32; // horizontal padding

	const measurements: CardMeasurement[] = [];

	for (const card of cards) {
		const titleEl = card.querySelector("h2");
		const descEl = card.querySelector("p:not(.blog-card-date)");
		const imageEl = card.querySelector(".blog-card-image");
		const tagsEl = card.querySelector(".blog-card-tags");

		let height = CARD_PADDING + DATE_HEIGHT;

		if (imageEl) height += IMAGE_HEIGHT;

		if (titleEl?.textContent) {
			const prepared = await prepareText(titleEl.textContent, titleFont);
			const result = await layoutText(prepared, textWidth, 24);
			height += result.height;
		}

		if (descEl?.textContent) {
			const prepared = await prepareText(descEl.textContent, descFont);
			const result = await layoutText(prepared, textWidth, 22);
			height += result.height;
		}

		if (tagsEl) height += TAGS_HEIGHT;

		measurements.push({ el: card, height });
	}

	return measurements;
}

function assignOrder(measurements: CardMeasurement[]): void {
	if (measurements.length === 0) return;

	// Greedy bin-pack into 2 columns
	const cols = [0, 0];
	const assignments: number[] = [];

	for (const m of measurements) {
		const target = cols[0] <= cols[1] ? 0 : 1;
		assignments.push(target);
		cols[target] += m.height + GAP;
	}

	// Assign CSS order: column 0 items first, then column 1
	const col0: number[] = [];
	const col1: number[] = [];
	for (let i = 0; i < assignments.length; i++) {
		if (assignments[i] === 0) col0.push(i);
		else col1.push(i);
	}

	const ordered = [...col0, ...col1];
	for (let i = 0; i < ordered.length; i++) {
		measurements[ordered[i]].el.style.order = String(i);
	}
}

async function layoutMasonry(): Promise<void> {
	const container = document.querySelector(".blog-index");
	if (!container) return;

	const cards = Array.from(container.querySelectorAll(".blog-card")) as HTMLElement[];
	if (cards.length < 3) return; // not enough cards for masonry

	// Calculate column width from container
	const containerWidth = container.clientWidth;
	const colWidth = (containerWidth - 24) / 2; // gap between columns

	if (colWidth < 280) {
		// Too narrow for 2 columns, reset to single column
		for (const card of cards) card.style.order = "";
		return;
	}

	container.classList.add("masonry-active");
	const measurements = await measureCards(cards, colWidth);
	assignOrder(measurements);
}

let resizeTimer: ReturnType<typeof setTimeout> | null = null;

function onResize(): void {
	if (resizeTimer) clearTimeout(resizeTimer);
	resizeTimer = setTimeout(() => layoutMasonry(), 150);
}

function init(): void {
	const container = document.querySelector(".blog-index");
	if (!container) return;

	layoutMasonry();
	window.addEventListener("resize", onResize);
}

function cleanup(): void {
	window.removeEventListener("resize", onResize);
	if (resizeTimer) {
		clearTimeout(resizeTimer);
		resizeTimer = null;
	}
}

let bound = false;
if (!bound) {
	bound = true;
	document.addEventListener("astro:page-load", init);
	document.addEventListener("astro:before-swap", cleanup);
	init();
}
