// Canvas text overlays rendered via pretext. Registers into the rAF loop
// from canvas-animations.ts via registerRenderer().

import { type AnimState, registerRenderer } from "./canvas-animations";
import { clearPretextCache, layoutText, prepareText, resolveSiteFont } from "./pretext-utils";

const CLUSTER_LABELS = ["EXTRACTION", "RETENTION", "SYNTHESIS", "INDEXING", "RETRIEVAL", "ENCODING", "DECAY"];

const CLUSTER_OFFSETS = [
	{ rx: 0.62, ry: 0.24 },
	{ rx: 0.78, ry: 0.52 },
	{ rx: 0.56, ry: 0.76 },
	{ rx: 0.88, ry: 0.36 },
	{ rx: 0.9, ry: 0.74 },
	{ rx: 0.2, ry: 0.3 },
	{ rx: 0.3, ry: 0.8 },
];

type LabelCache = {
	prepared: Awaited<ReturnType<typeof prepareText>>;
	text: string;
	width: number;
};

let labels: LabelCache[] | null = null;
let lastFont = "";
let cleanup: (() => void) | null = null;
let lastDraw = 0;

async function prepareLabelCache(font: string): Promise<void> {
	const entries: LabelCache[] = [];
	for (const text of CLUSTER_LABELS) {
		const prepared = await prepareText(text, font);
		const result = await layoutText(prepared, 9999, 12);
		// Single line, so width is approximate from lineCount * char estimate.
		// We'll measure with canvas directly for positioning.
		entries.push({ prepared, text, width: 0 });
	}
	labels = entries;
	lastFont = font;
}

function drawClusterLabels(state: AnimState): void {
	// Throttle to ~10fps, cluster labels don't need fast updates
	const now = performance.now();
	if (now - lastDraw < 100) return;
	lastDraw = now;

	if (state.lowPowerMode) return;
	if (!labels) return;

	const { ctx, width, height, isDark } = state;

	ctx.save();
	const font = resolveSiteFont("mono", 9, 500);
	ctx.font = font;
	ctx.textAlign = "center";
	ctx.textBaseline = "middle";
	ctx.fillStyle = isDark ? "rgba(138, 138, 150, 0.15)" : "rgba(106, 102, 96, 0.12)";

	for (let i = 0; i < CLUSTER_OFFSETS.length && i < labels.length; i++) {
		const offset = CLUSTER_OFFSETS[i];
		const label = labels[i];
		const x = offset.rx * width;
		const y = offset.ry * height;
		ctx.fillText(label.text, x, y - 20);
	}

	ctx.restore();
}

export function initOverlays(): void {
	if (cleanup) cleanup();

	const font = resolveSiteFont("mono", 9, 500);
	prepareLabelCache(font);

	cleanup = registerRenderer(drawClusterLabels);
}

export function destroyOverlays(): void {
	if (cleanup) {
		cleanup();
		cleanup = null;
	}
	labels = null;
	clearPretextCache();
}

// Auto-init on page load, matching canvas-animations.ts lifecycle
let bound = false;
if (!bound) {
	bound = true;

	function init() {
		const canvas = document.getElementById("latent-topology");
		if (canvas instanceof HTMLCanvasElement) {
			initOverlays();
		}
	}

	document.addEventListener("astro:page-load", init);
	document.addEventListener("astro:before-swap", destroyOverlays);
	init();
}
