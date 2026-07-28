// initLatentTopology: ASCII dither background + latent topology graph + machined bars.

export type AnimState = {
	ctx: CanvasRenderingContext2D;
	width: number;
	height: number;
	time: number;
	isDark: boolean;
	lowPowerMode: boolean;
};

type Renderer = (state: AnimState) => void;
const renderers: Set<Renderer> = new Set();

export function registerRenderer(fn: Renderer): () => void {
	renderers.add(fn);
	return () => {
		renderers.delete(fn);
	};
}

type Node = {
	id: string;
	x: number;
	y: number;
	vx: number;
	vy: number;
	baseX: number;
	baseY: number;
	isHub: boolean;
	pulse: number;
};

let topologyCleanup: (() => void) | null = null;

function cleanupLatentTopology() {
	if (typeof topologyCleanup === "function") {
		topologyCleanup();
		topologyCleanup = null;
	}
}

function initLatentTopology() {
	cleanupLatentTopology();

	const canvasEl = document.getElementById("latent-topology");
	const asciiCanvasEl = document.getElementById("ascii-dither");
	const barsCanvasEl = document.getElementById("hero-bg-bars");

	if (!(canvasEl instanceof HTMLCanvasElement)) return;
	if (!(asciiCanvasEl instanceof HTMLCanvasElement)) return;
	if (!(barsCanvasEl instanceof HTMLCanvasElement)) return;

	const ctx = canvasEl.getContext("2d")!;
	const asciiCtx = asciiCanvasEl.getContext("2d")!;
	const barsCtx = barsCanvasEl.getContext("2d")!;

	let width = window.innerWidth;
	let height = window.innerHeight;

	const isDark = document.documentElement.getAttribute("data-theme") === "dark";
	const accentColor = getComputedStyle(document.documentElement).getPropertyValue("--color-accent").trim() || "#c8ff00";

	const nodeColor = isDark ? "rgba(138, 138, 150, 0.4)" : "rgba(106, 102, 96, 0.4)";
	const edgeColor = isDark ? "rgba(255, 255, 255, 0.08)" : "rgba(0, 0, 0, 0.08)";
	const highlightColor = accentColor;
	const ditherColor = isDark ? "rgba(255, 255, 255, 0.02)" : "rgba(0, 0, 0, 0.03)";

	const lowPowerMode =
		window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
		window.matchMedia("(max-width: 900px)").matches ||
		navigator.hardwareConcurrency <= 4;

	// Machined Bars Setup - Lower opacity and fewer bars for subtler look
	const bars: { x: number; width: number; speed: number; opacity: number }[] = [];
	const numBars = 10;
	for (let i = 0; i < numBars; i++) {
		bars.push({
			x: (i / numBars) * width * 2,
			width: 60 + Math.random() * 120,
			speed: 0.1 + Math.random() * 0.3,
			opacity: 0.04 + Math.random() * 0.08,
		});
	}

	// Nodes Setup
	const numNodes = lowPowerMode ? 40 : 120;
	const nodes: Node[] = [];
	const clusters = [
		{ x: width * 0.62, y: height * 0.24, r: 200 },
		{ x: width * 0.78, y: height * 0.52, r: 250 },
		{ x: width * 0.56, y: height * 0.76, r: 180 },
		{ x: width * 0.2, y: height * 0.3, r: 220 },
		{ x: width * 0.3, y: height * 0.8, r: 180 },
	];

	for (let i = 0; i < numNodes; i++) {
		const cluster = clusters[Math.floor(Math.random() * clusters.length)];
		const u = 1 - Math.random();
		const v = Math.random();
		const z = Math.sqrt(-2.0 * Math.log(u)) * Math.cos(2.0 * Math.PI * v);

		nodes.push({
			id: `0x${Math.floor(Math.random() * 65535)
				.toString(16)
				.toUpperCase()
				.padStart(4, "0")}`,
			x: cluster.x + z * (cluster.r / 2),
			y: cluster.y + (Math.random() - 0.5) * cluster.r,
			vx: (Math.random() - 0.5) * 0.1,
			vy: (Math.random() - 0.5) * 0.1,
			baseX: 0,
			baseY: 0,
			isHub: Math.random() > 0.92,
			pulse: Math.random() * Math.PI * 2,
		});
		nodes[i].baseX = nodes[i].x;
		nodes[i].baseY = nodes[i].y;
	}

	function resize() {
		const dpr = Math.min(window.devicePixelRatio || 1, 2);
		width = window.innerWidth;
		height = window.innerHeight;

		[canvasEl, asciiCanvasEl, barsCanvasEl].forEach((c) => {
			c.width = width * dpr;
			c.height = height * dpr;
			const context = c.getContext("2d")!;
			context.setTransform(dpr, 0, 0, dpr, 0, 0);
		});
	}

	window.addEventListener("resize", resize);
	resize();

	const mouse = { x: -1000, y: -1000 };
	document.addEventListener("mousemove", (e) => {
		mouse.x = e.clientX;
		mouse.y = e.clientY;
	});

	let time = 0;
	let rafId: number | null = null;
	let lastAsciiDraw = 0;

	function drawBars() {
		barsCtx.clearRect(0, 0, width, height);

		barsCtx.save();
		barsCtx.rotate(-Math.PI / 4);
		barsCtx.translate(-width, 0);

		bars.forEach((bar) => {
			bar.x += bar.speed * (isDark ? 0.5 : -0.5);
			if (bar.x > width * 3) bar.x = -width;
			if (bar.x < -width) bar.x = width * 3;

			const gradient = barsCtx.createLinearGradient(bar.x, 0, bar.x + bar.width, 0);
			const baseColor = accentColor;

			// Softer gradient transition
			gradient.addColorStop(0, "transparent");
			gradient.addColorStop(
				0.5,
				`${baseColor}${Math.floor(bar.opacity * 255)
					.toString(16)
					.padStart(2, "0")}`,
			);
			gradient.addColorStop(1, "transparent");

			barsCtx.fillStyle = gradient;
			barsCtx.fillRect(bar.x, -height * 2, bar.width, height * 4);
		});
		barsCtx.restore();

		// More aggressive vignette mask for atmospheric focus
		const mask = barsCtx.createRadialGradient(
			width / 2,
			height * 0.3,
			width * 0.1,
			width / 2,
			height * 0.3,
			width * 0.6,
		);
		mask.addColorStop(0, "rgba(0,0,0,0.8)");
		mask.addColorStop(1, "rgba(0,0,0,0)");

		barsCtx.globalCompositeOperation = "destination-in";
		barsCtx.fillStyle = mask;
		barsCtx.fillRect(0, 0, width, height);
		barsCtx.globalCompositeOperation = "source-over";
	}

	function drawAscii() {
		const now = performance.now();
		if (now - lastAsciiDraw < 80) return;
		lastAsciiDraw = now;

		asciiCtx.clearRect(0, 0, width, height);
		asciiCtx.fillStyle = ditherColor;
		asciiCtx.font = '500 9px "IBM Plex Mono", monospace';

		const step = 32;
		for (let y = 0; y < height; y += step) {
			for (let x = 0; x < width; x += step) {
				const noise = Math.sin(x * 0.002 + time * 0.5) * Math.cos(y * 0.002 + time * 0.5);
				if (Math.abs(noise) > 0.5) {
					asciiCtx.fillText("01_.*+=".split("")[Math.floor(Math.abs(noise) * 7) % 7], x, y);
				}
			}
		}
	}

	function drawNodes() {
		time += 0.005;
		drawBars();
		drawAscii();
		ctx.clearRect(0, 0, width, height);

		let hoveredNode: Node | null = null;
		let minDist = 60;

		nodes.forEach((n) => {
			n.x += n.vx;
			n.y += n.vy;
			n.x += (n.baseX - n.x) * 0.01;
			n.y += (n.baseY - n.y) * 0.01;
			n.pulse += 0.02;

			const dx = mouse.x - n.x;
			const dy = mouse.y - n.y;
			const d = Math.sqrt(dx * dx + dy * dy);
			if (d < 150) {
				n.x -= (dx / d) * 0.5;
				n.y -= (dy / d) * 0.5;
				if (d < minDist) {
					minDist = d;
					hoveredNode = n;
				}
			}
		});

		ctx.lineWidth = 0.5;
		for (let i = 0; i < nodes.length; i++) {
			let connections = 0;
			for (let j = i + 1; j < nodes.length; j++) {
				const a = nodes[i],
					b = nodes[j];
				const dx = a.x - b.x,
					dy = a.y - b.y;
				if (dx * dx + dy * dy < 15000 && connections < 3) {
					const isHoveredEdge = hoveredNode === a || hoveredNode === b;
					ctx.strokeStyle = isHoveredEdge ? highlightColor : edgeColor;
					ctx.globalAlpha = isHoveredEdge ? 0.4 : 0.3;
					ctx.beginPath();
					ctx.moveTo(a.x, a.y);
					ctx.lineTo(b.x, b.y);
					ctx.stroke();
					if (isHoveredEdge || (i + j) % 11 === 0) {
						const speed = 3000;
						const t = ((Date.now() + i * 500) % speed) / speed;
						ctx.fillStyle = isHoveredEdge ? highlightColor : accentColor;
						ctx.globalAlpha = isHoveredEdge ? 0.8 : 0.2;
						ctx.beginPath();
						ctx.arc(a.x + (b.x - a.x) * t, a.y + (b.y - a.y) * t, isHoveredEdge ? 2 : 1, 0, Math.PI * 2);
						ctx.fill();
					}
					connections++;
				}
			}
		}

		ctx.globalAlpha = 1;
		nodes.forEach((n) => {
			const isHovered = n === hoveredNode;
			ctx.strokeStyle = isHovered ? highlightColor : nodeColor;
			ctx.lineWidth = isHovered ? 1.5 : 1;
			const size = n.isHub ? 4 : 2;
			const p = Math.sin(n.pulse) * 2;
			if (n.isHub || isHovered) {
				ctx.beginPath();
				ctx.arc(n.x, n.y, size + 2 + p, 0, Math.PI * 2);
				ctx.strokeStyle = isHovered ? highlightColor : edgeColor;
				ctx.stroke();
			}
			ctx.beginPath();
			ctx.moveTo(n.x - size, n.y);
			ctx.lineTo(n.x + size, n.y);
			ctx.moveTo(n.x, n.y - size);
			ctx.lineTo(n.x, n.y + size);
			ctx.stroke();
			if (isHovered) {
				ctx.fillStyle = "rgba(0,0,0,0.8)";
				ctx.strokeStyle = highlightColor;
				ctx.beginPath();
				ctx.roundRect(n.x + 10, n.y - 40, 90, 30, 4);
				ctx.fill();
				ctx.stroke();
				ctx.fillStyle = highlightColor;
				ctx.font = '700 8px "IBM Plex Mono", monospace';
				ctx.fillText(`ID: ${n.id}`, n.x + 18, n.y - 28);
				ctx.font = '400 7px "IBM Plex Mono", monospace';
				ctx.fillText(`LOC: ${Math.round(n.x)},${Math.round(n.y)}`, n.x + 18, n.y - 18);
			}
		});

		// Dispatch to registered external renderers
		const state: AnimState = { ctx, width, height, time, isDark, lowPowerMode };
		for (const fn of renderers) fn(state);

		rafId = requestAnimationFrame(drawNodes);
	}

	rafId = requestAnimationFrame(drawNodes);

	topologyCleanup = () => {
		if (rafId) cancelAnimationFrame(rafId);
		window.removeEventListener("resize", resize);
	};
}

window.initLatentTopology = initLatentTopology;
document.addEventListener("astro:page-load", () => window.initLatentTopology?.());
document.addEventListener("astro:before-swap", cleanupLatentTopology);
initLatentTopology();
