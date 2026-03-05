<script lang="ts">
import type { EraMarker, TimeBucket } from "$lib/stores/timeline.svelte";
import { onMount } from "svelte";

interface Props {
	buckets: TimeBucket[];
	eras: EraMarker[];
	onbucketclick: (bucket: TimeBucket) => void;
	oneraclick: (era: EraMarker) => void;
}

// biome-ignore lint/style/useConst: Svelte keeps prop bindings reactive.
let { buckets, eras, onbucketclick, oneraclick }: Props = $props();

// biome-ignore lint/style/useConst: Mutated by bind:this.
let canvas = $state<HTMLCanvasElement | null>(null);

// Camera state
let camX = 0;
let camZoom = 1;
const CAM_Y = 0;

// Interaction state
let isPanning = false;
let panStartX = 0;
let panCamStartX = 0;

let animFrame = 0;
let needsRedraw = true;
let hoveredBucket: TimeBucket | null = null;
let hoveredEra: EraMarker | null = null;

// Layout constants
const PADDING_LEFT = 60;
const PADDING_RIGHT = 40;
const PADDING_TOP = 80;
const PADDING_BOTTOM = 60;
const BAR_GAP = 2;
const ERA_HEIGHT = 24;
const TRACK_HEIGHT = 32;
const AXIS_HEIGHT = 40;

// Colors
const COLORS = {
	bg: "#0e0e12",
	eraBg: "rgba(59, 130, 246, 0.15)",
	eraBorder: "rgba(59, 130, 246, 0.4)",
	barFill: "#10b981",
	barHover: "#34d399",
	text: "#a1a1aa",
	textBright: "#d4d4d8",
	grid: "rgba(255, 255, 255, 0.05)",
};

function parseDate(dateStr: string): Date | null {
	const date = new Date(dateStr);
	return Number.isNaN(date.getTime()) ? null : date;
}

function requestRedraw(): void {
	needsRedraw = true;
	if (animFrame) return; // Already have a pending frame
	if (!canvas) return;

	const ctx = canvas.getContext("2d");
	if (!ctx) return;

	animFrame = requestAnimationFrame(() => draw(ctx));
}

function resizeCanvas(): void {
	if (!canvas) return;
	const parent = canvas.parentElement;
	if (!parent) return;

	const rect = parent.getBoundingClientRect();

	// Guard against zero dimensions
	if (rect.width === 0 || rect.height === 0) return;

	const dpr = window.devicePixelRatio || 1;

	canvas.width = rect.width * dpr;
	canvas.height = rect.height * dpr;
	canvas.style.width = `${rect.width}px`;
	canvas.style.height = `${rect.height}px`;

	const ctx = canvas.getContext("2d");
	if (!ctx) return;

	ctx.scale(dpr, dpr);
	requestRedraw();
}

function draw(ctx: CanvasRenderingContext2D): void {
	if (!canvas) return;

	const width = canvas.width / (window.devicePixelRatio || 1);
	const height = canvas.height / (window.devicePixelRatio || 1);

	ctx.fillStyle = COLORS.bg;
	ctx.fillRect(0, 0, width, height);

	if (buckets.length === 0) {
		ctx.fillStyle = COLORS.text;
		ctx.font = "12px var(--font-mono)";
		ctx.textAlign = "center";
		ctx.fillText("No timeline data", width / 2, height / 2);
		return;
	}

	const plotWidth = width - PADDING_LEFT - PADDING_RIGHT;
	const plotHeight = height - PADDING_TOP - PADDING_BOTTOM;

	// Calculate bar width
	const totalBars = buckets.length;
	if (totalBars === 0) return;

	const barWidth = Math.max(4, (plotWidth / totalBars) * camZoom - BAR_GAP);

	// Calculate max count for scaling
	const counts = buckets.map((b) => b.memory_count);
	const maxCount = counts.length > 0 ? Math.max(...counts, 1) : 1;

	// Draw eras
	drawEras(ctx, plotWidth, plotHeight);

	// Draw grid
	drawGrid(ctx, plotWidth, plotHeight, maxCount);

	// Draw bars
	drawBars(ctx, plotWidth, plotHeight, maxCount, barWidth);

	// Draw axis
	drawAxis(ctx, plotWidth, height);

	animFrame = 0;
}

function drawEras(
	ctx: CanvasRenderingContext2D,
	plotWidth: number,
	plotHeight: number,
): void {
	eras.forEach((era) => {
		const startX = dateToX(era.startDate, plotWidth);
		const endX = dateToX(era.endDate, plotWidth);
		const width = Math.max(1, endX - startX);

		ctx.fillStyle = COLORS.eraBg;
		ctx.fillRect(startX, PADDING_TOP, width, ERA_HEIGHT);

		ctx.strokeStyle = COLORS.eraBorder;
		ctx.lineWidth = 1;
		ctx.strokeRect(startX, PADDING_TOP, width, ERA_HEIGHT);

		// Label
		ctx.fillStyle = COLORS.textBright;
		ctx.font = "bold 10px var(--font-mono)";
		ctx.textAlign = "left";
		const labelX = startX + 4;
		if (labelX + 50 < endX) {
			ctx.fillText(era.label.substring(0, Math.floor(width / 7)), labelX, PADDING_TOP + 16);
		}
	});
}

function drawGrid(
	ctx: CanvasRenderingContext2D,
	plotWidth: number,
	plotHeight: number,
	maxCount: number,
): void {
	ctx.strokeStyle = COLORS.grid;
	ctx.lineWidth = 1;

	// Horizontal grid lines
	const numLines = 5;
	for (let i = 0; i <= numLines; i++) {
		const y = PADDING_TOP + ERA_HEIGHT + (i / numLines) * (plotHeight - ERA_HEIGHT - AXIS_HEIGHT);
		ctx.beginPath();
		ctx.moveTo(PADDING_LEFT, y);
		ctx.lineTo(PADDING_LEFT + plotWidth, y);
		ctx.stroke();

		// Label
		const value = Math.round(maxCount * (1 - i / numLines));
		ctx.fillStyle = COLORS.text;
		ctx.font = "9px var(--font-mono)";
		ctx.textAlign = "right";
		ctx.fillText(value.toString(), PADDING_LEFT - 8, y + 3);
	}
}

function drawBars(
	ctx: CanvasRenderingContext2D,
	plotWidth: number,
	plotHeight: number,
	maxCount: number,
	barWidth: number,
): void {
	const barAreaTop = PADDING_TOP + ERA_HEIGHT;
	const barAreaHeight = plotHeight - ERA_HEIGHT - AXIS_HEIGHT;

	buckets.forEach((bucket, i) => {
		const x = PADDING_LEFT + i * (barWidth + BAR_GAP) + camX;
		if (x < PADDING_LEFT - barWidth || x > PADDING_LEFT + plotWidth) return;

		const barHeight = (bucket.memory_count / maxCount) * barAreaHeight;
		const y = barAreaTop + barAreaHeight - barHeight;

		const isHovered = hoveredBucket === bucket;
		ctx.fillStyle = isHovered ? COLORS.barHover : COLORS.barFill;
		ctx.fillRect(x, y, barWidth, barHeight);
	});
}

function drawAxis(
	ctx: CanvasRenderingContext2D,
	plotWidth: number,
	height: number,
): void {
	const axisY = height - PADDING_BOTTOM;

	// Draw axis line
	ctx.strokeStyle = COLORS.grid;
	ctx.lineWidth = 1;
	ctx.beginPath();
	ctx.moveTo(PADDING_LEFT, axisY);
	ctx.lineTo(PADDING_LEFT + plotWidth, axisY);
	ctx.stroke();

	// Draw date labels
	const labelInterval = Math.max(1, Math.floor(buckets.length / 10));
	ctx.fillStyle = COLORS.text;
	ctx.font = "9px var(--font-mono)";
	ctx.textAlign = "center";

	buckets.forEach((bucket, i) => {
		if (i % labelInterval !== 0) return;

		const x = PADDING_LEFT + i * ((plotWidth / buckets.length) * camZoom) + camX;
		if (x < PADDING_LEFT || x > PADDING_LEFT + plotWidth) return;

		const date = parseDate(bucket.bucket);
		if (!date) return;

		const label = `${date.getMonth() + 1}/${date.getDate()}`;

		ctx.fillText(label, x, axisY + 16);
	});
}

function dateToX(date: string, plotWidth: number): number {
	if (buckets.length === 0) return 0;

	const firstBucket = buckets[0];
	const lastBucket = buckets[buckets.length - 1];

	if (!firstBucket || !lastBucket) return PADDING_LEFT;

	const targetDate = parseDate(date);
	const firstDate = parseDate(firstBucket.bucket);
	const lastDate = parseDate(lastBucket.bucket);

	if (!targetDate || !firstDate || !lastDate) return PADDING_LEFT;

	const targetTime = targetDate.getTime();
	const firstTime = firstDate.getTime();
	const lastTime = lastDate.getTime();
	const totalDays = (lastTime - firstTime) / (1000 * 60 * 60 * 24);

	if (totalDays === 0) return PADDING_LEFT;

	const daysDiff = (targetTime - firstTime) / (1000 * 60 * 60 * 24);
	const x = PADDING_LEFT + (daysDiff / totalDays) * plotWidth * camZoom + camX;

	return x;
}

function handleMouseMove(event: MouseEvent): void {
	if (!canvas || buckets.length === 0) return;

	const rect = canvas.getBoundingClientRect();
	const x = event.clientX - rect.left;
	const y = event.clientY - rect.top;

	// Check for bucket hover
	const plotWidth = rect.width - PADDING_LEFT - PADDING_RIGHT;
	const barWidth = (plotWidth / buckets.length) * camZoom - BAR_GAP;

	let found: TimeBucket | null = null;
	buckets.forEach((bucket, i) => {
		const bx = PADDING_LEFT + i * (barWidth + BAR_GAP) + camX;
		if (x >= bx && x <= bx + barWidth) {
			found = bucket;
		}
	});

	if (found !== hoveredBucket) {
		hoveredBucket = found;
		canvas.style.cursor = found ? "pointer" : "default";
		requestRedraw();
	}
}

function handleClick(event: MouseEvent): void {
	if (hoveredBucket) {
		onbucketclick(hoveredBucket);
	}
}

function handleWheel(event: WheelEvent): void {
	event.preventDefault();
	const delta = event.deltaY > 0 ? 0.9 : 1.1;
	camZoom = Math.max(0.5, Math.min(5, camZoom * delta));
	requestRedraw();
}

function handleMouseDown(event: MouseEvent): void {
	if (event.button !== 0) return;
	isPanning = true;
	panStartX = event.clientX;
	panCamStartX = camX;
}

function handleMouseMovePan(event: MouseEvent): void {
	if (!isPanning) return;
	const dx = event.clientX - panStartX;
	camX = panCamStartX + dx;
	requestRedraw();
}

function handleMouseUp(): void {
	isPanning = false;
}

function handleKeyDown(event: KeyboardEvent): void {
	if (!canvas) return;

	const panAmount = 50;
	const zoomAmount = 0.1;

	switch (event.key) {
		case "ArrowLeft":
			event.preventDefault();
			camX -= panAmount;
			requestRedraw();
			break;
		case "ArrowRight":
			event.preventDefault();
			camX += panAmount;
			requestRedraw();
			break;
		case "+":
		case "=":
			event.preventDefault();
			camZoom = Math.min(5, camZoom * (1 + zoomAmount));
			requestRedraw();
			break;
		case "-":
			event.preventDefault();
			camZoom = Math.max(0.5, camZoom * (1 - zoomAmount));
			requestRedraw();
			break;
		case "0":
			event.preventDefault();
			camX = 0;
			camZoom = 1;
			requestRedraw();
			break;
	}
}

function setupInteractions(): void {
	if (!canvas) return;

	canvas.addEventListener("mousemove", handleMouseMove);
	canvas.addEventListener("click", handleClick);
	canvas.addEventListener("wheel", handleWheel, { passive: false });
	canvas.addEventListener("mousedown", handleMouseDown);
	canvas.addEventListener("keydown", handleKeyDown);
	window.addEventListener("mousemove", handleMouseMovePan);
	window.addEventListener("mouseup", handleMouseUp);
}

function cleanupInteractions(): void {
	if (!canvas) return;

	canvas.removeEventListener("mousemove", handleMouseMove);
	canvas.removeEventListener("click", handleClick);
	canvas.removeEventListener("wheel", handleWheel);
	canvas.removeEventListener("mousedown", handleMouseDown);
	canvas.removeEventListener("keydown", handleKeyDown);
	window.removeEventListener("mousemove", handleMouseMovePan);
	window.removeEventListener("mouseup", handleMouseUp);
}

onMount(() => {
	resizeCanvas();
	setupInteractions();
	window.addEventListener("resize", resizeCanvas);

	return () => {
		cleanupInteractions();
		window.removeEventListener("resize", resizeCanvas);
		cancelAnimationFrame(animFrame);
	};
});

$effect(() => {
	// Track bucket and era changes
	buckets;
	eras;
	requestRedraw();
});
</script>

<canvas
	bind:this={canvas}
	class="w-full h-full"
	style="display: block;"
	tabindex="0"
	role="img"
	aria-label="Timeline visualization showing memory activity over time. Use arrow keys to pan, plus/minus to zoom, and 0 to reset."
></canvas>
