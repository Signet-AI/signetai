// initLatentTopology: ASCII dither background + latent topology graph + hex stream.

declare global {
	interface Window {
		initLatentTopology?: () => void;
	}
}

export {};

let topologyCleanup: (() => void) | null = null;
let lifecycleBound = false;

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
	if (!(canvasEl instanceof HTMLCanvasElement)) return;
	if (!(asciiCanvasEl instanceof HTMLCanvasElement)) return;

	const canvas: HTMLCanvasElement = canvasEl;
	const asciiCanvas: HTMLCanvasElement = asciiCanvasEl;
	const ctxMaybe = canvas.getContext("2d");
	const asciiCtxMaybe = asciiCanvas.getContext("2d");
	if (!ctxMaybe || !asciiCtxMaybe) return;

	const ctx: CanvasRenderingContext2D = ctxMaybe;
	const asciiCtx: CanvasRenderingContext2D = asciiCtxMaybe;

	let width = window.innerWidth;
	let height = window.innerHeight;

	const isDark = document.documentElement.getAttribute("data-theme") === "dark";
	const nodeColor = isDark ? "rgba(138, 138, 150, 0.8)" : "rgba(106, 102, 96, 0.8)";
	const edgeColor = isDark ? "rgba(255, 255, 255, 0.15)" : "rgba(0, 0, 0, 0.15)";
	const highlightColor = isDark ? "rgba(240, 240, 242, 1)" : "rgba(10, 10, 12, 1)";
	const ditherColor = isDark ? "rgba(255, 255, 255, 0.03)" : "rgba(0, 0, 0, 0.04)";
	const surfaceColor = isDark ? "#0e0e12" : "#dbd5cd";
	const lowPowerMode =
		window.matchMedia("(prefers-reduced-motion: reduce)").matches ||
		window.matchMedia("(max-width: 900px)").matches ||
		navigator.hardwareConcurrency <= 4;

	const numNodes = lowPowerMode ? 36 : 96;
	const clusters = [
		{ x: width * 0.62, y: height * 0.24, r: 160 },
		{ x: width * 0.78, y: height * 0.52, r: 210 },
		{ x: width * 0.56, y: height * 0.76, r: 140 },
		{ x: width * 0.88, y: height * 0.36, r: 120 },
		{ x: width * 0.9, y: height * 0.74, r: 150 },
		{ x: width * 0.2, y: height * 0.3, r: 180 },
		{ x: width * 0.3, y: height * 0.8, r: 150 },
	];

	type Node = {
		id: string;
		x: number;
		y: number;
		vx: number;
		vy: number;
		baseX: number;
		baseY: number;
		isHub: boolean;
	};

	const nodes: Node[] = [];
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
			vx: (Math.random() - 0.5) * 0.2,
			vy: (Math.random() - 0.5) * 0.2,
			baseX: 0,
			baseY: 0,
			isHub: Math.random() > 0.95,
		});
		nodes[i].baseX = nodes[i].x;
		nodes[i].baseY = nodes[i].y;
	}

	function resize() {
		const nextWidth = window.innerWidth;
		const nextHeight = window.innerHeight;

		const oldWidth = width || nextWidth;
		const oldHeight = height || nextHeight;

		width = nextWidth;
		height = nextHeight;

		const scaleX = oldWidth ? width / oldWidth : 1;
		const scaleY = oldHeight ? height / oldHeight : 1;

		nodes.forEach((node) => {
			node.x *= scaleX;
			node.y *= scaleY;
			node.baseX *= scaleX;
			node.baseY *= scaleY;
		});

		const dpr = Math.min(window.devicePixelRatio || 1, lowPowerMode ? 1 : 1.5);

		canvas.width = Math.max(1, Math.floor(width * dpr));
		canvas.height = Math.max(1, Math.floor(height * dpr));
		ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

		asciiCanvas.width = Math.max(1, Math.floor(width * dpr));
		asciiCanvas.height = Math.max(1, Math.floor(height * dpr));
		asciiCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	const onResize = () => resize();
	window.addEventListener("resize", onResize);
	resize();

	const mouse = { x: -1000, y: -1000 };
	const onMouseMove = (e: MouseEvent) => {
		mouse.x = e.clientX;
		mouse.y = e.clientY;
	};
	const onMouseLeave = () => {
		mouse.x = -1000;
		mouse.y = -1000;
	};

	if (!lowPowerMode) {
		document.addEventListener("mousemove", onMouseMove);
		document.addEventListener("mouseleave", onMouseLeave);
	}

	const chars = "01_.*+=".split("");
	let time = 0;
	let rafId: number | null = null;
	let lastAsciiDraw = 0;
	let animationActive = !document.hidden;

	// 1. ASCII Dithering Background (throttled for perf)
	function drawAscii() {
		const now = performance.now();
		const minIntervalMs = lowPowerMode ? 150 : 70;
		if (now - lastAsciiDraw > minIntervalMs) {
			lastAsciiDraw = now;
			asciiCtx.clearRect(0, 0, width, height);
			asciiCtx.fillStyle = ditherColor;
			asciiCtx.font = '500 10px "IBM Plex Mono", monospace';

			const step = lowPowerMode ? 44 : 32;
			for (let y = 0; y < height; y += step) {
				for (let x = 0; x < width; x += step) {
					const noise = Math.sin(x * 0.003 + time) * Math.cos(y * 0.003 + time);
					if (Math.abs(noise) > 0.4) {
						const char = chars[Math.floor(Math.abs(noise) * chars.length) % chars.length];
						asciiCtx.fillText(char, x, y);
					}
				}
			}
		}
	}

	// 2. Nodes and connections
	function drawNodes() {
		if (!animationActive) {
			rafId = null;
			return;
		}

		drawAscii();
		ctx.clearRect(0, 0, width, height);
		time += 0.01;

		let hoveredNode: Node | null = null;
		let minDist = Number.POSITIVE_INFINITY;

		for (let i = 0; i < numNodes; i++) {
			const n = nodes[i];
			n.x += n.vx;
			n.y += n.vy;
			n.x += (n.baseX - n.x) * 0.005;
			n.y += (n.baseY - n.y) * 0.005;

			const dx = mouse.x - n.x;
			const dy = mouse.y - n.y;
			const dist = Math.sqrt(dx * dx + dy * dy);

			if (dist < 120 && dist > 0.001) {
				n.x -= (dx / dist) * 1.5;
				n.y -= (dy / dist) * 1.5;
			}

			if (dist < 40 && dist < minDist) {
				minDist = dist;
				hoveredNode = n;
			}
		}

		ctx.lineWidth = 1;
		for (let i = 0; i < numNodes; i++) {
			let connections = 0;
			for (let j = i + 1; j < numNodes; j++) {
				const dx = nodes[i].x - nodes[j].x;
				const dy = nodes[i].y - nodes[j].y;
				const dist = dx * dx + dy * dy;

				if (dist < 12000 && connections < 4) {
					const a = nodes[i];
					const b = nodes[j];

					// Quadratic bezier with 12% offset
					const mx = (a.x + b.x) / 2 + dy * 0.12;
					const my = (a.y + b.y) / 2 - dx * 0.12;

					ctx.beginPath();
					ctx.moveTo(a.x, a.y);
					ctx.quadraticCurveTo(mx, my, b.x, b.y);

					const isHoveredEdge = hoveredNode === a || hoveredNode === b;

					if (isHoveredEdge) {
						ctx.strokeStyle = highlightColor;
						ctx.lineWidth = 1.5;
						ctx.setLineDash([]);
					} else {
						ctx.strokeStyle = edgeColor;
						ctx.lineWidth = 1;
						// Fix flicker: use deterministic dash based on node indices
						ctx.setLineDash((i + j) % 3 === 0 ? [4, 6] : []);
					}

					ctx.stroke();

					// Fix flicker: use deterministic packet spawning
					if (isHoveredEdge || (i * j) % 7 === 0) {
						// Stable speed and offset so packets don't jump around
						const speed = 2000 + ((i + j) % 3) * 1000;
						const offset = (i * j * 333) % speed;
						const t = ((Date.now() + offset) % speed) / speed;

						const px = (1 - t) * (1 - t) * a.x + 2 * (1 - t) * t * mx + t * t * b.x;
						const py = (1 - t) * (1 - t) * a.y + 2 * (1 - t) * t * my + t * t * b.y;

						ctx.beginPath();
						ctx.arc(px, py, isHoveredEdge ? 2 : 1.5, 0, Math.PI * 2);
						ctx.fillStyle = isHoveredEdge ? highlightColor : nodeColor;
						ctx.fill();
					}

					connections++;
				}
				if (connections >= 4) break;
			}
		}
		ctx.setLineDash([]);

		for (let i = 0; i < numNodes; i++) {
			const n = nodes[i];
			const isHovered = n === hoveredNode;

			ctx.strokeStyle = isHovered ? highlightColor : nodeColor;
			ctx.lineWidth = isHovered ? 1.5 : 1;

			const size = isHovered ? 8 : n.isHub ? 6 : 4;

			// Draw Crosshair
			ctx.beginPath();
			ctx.moveTo(n.x - size, n.y);
			ctx.lineTo(n.x + size, n.y);
			ctx.moveTo(n.x, n.y - size);
			ctx.lineTo(n.x, n.y + size);
			ctx.stroke();

			// Draw Hub Circle
			if (n.isHub || isHovered) {
				ctx.beginPath();
				ctx.arc(n.x, n.y, size + 4, 0, Math.PI * 2);
				ctx.strokeStyle = isHovered ? highlightColor : edgeColor;
				ctx.stroke();
			}

			// Draw Hover HUD
			if (isHovered) {
				ctx.save();
				ctx.translate(n.x, n.y);
				ctx.rotate(time * 2);
				ctx.beginPath();
				ctx.arc(0, 0, 18, 0, Math.PI * 2);
				ctx.setLineDash([4, 4]);
				ctx.strokeStyle = highlightColor;
				ctx.stroke();
				ctx.restore();

				ctx.fillStyle = surfaceColor;
				ctx.strokeStyle = highlightColor;
				ctx.setLineDash([]);
				ctx.fillRect(n.x - 40, n.y - 45, 80, 26);
				ctx.strokeRect(n.x - 40, n.y - 45, 80, 26);

				ctx.beginPath();
				ctx.moveTo(n.x, n.y - 19);
				ctx.lineTo(n.x, n.y - 12);
				ctx.stroke();

				ctx.fillStyle = highlightColor;
				ctx.font = '8px "IBM Plex Mono", monospace';
				ctx.textAlign = "center";
				ctx.fillText(`MEM: ${n.id}`, n.x, n.y - 34);
				ctx.fillText("STS: ACTIVE", n.x, n.y - 24);
			}
		}

		rafId = requestAnimationFrame(drawNodes);
	}

	function startLoops() {
		if (rafId !== null) return;
		rafId = requestAnimationFrame(drawNodes);
	}

	function stopLoops() {
		if (rafId !== null) {
			cancelAnimationFrame(rafId);
			rafId = null;
		}
	}

	const onVisibilityChange = () => {
		animationActive = !document.hidden;
		if (animationActive) {
			startLoops();
			return;
		}
		stopLoops();
	};

	document.addEventListener("visibilitychange", onVisibilityChange);
	startLoops();

	// Populate Hex Stream using safe DOM methods (all content is programmatically generated)
	const hexContent = document.querySelector(".hex-content");
	if (hexContent) {
		const frag = document.createDocumentFragment();
		// Duplicate rows for seamless CSS scroll loop
		const rows = lowPowerMode ? 40 : 80;
		for (let rep = 0; rep < 2; rep++) {
			for (let i = 0; i < rows; i++) {
				const addr = `0x${Math.floor(Math.random() * 65535)
					.toString(16)
					.padStart(4, "0")
					.toUpperCase()}`;
				const data1 = Math.random().toString(16).substring(2, 10).toUpperCase();
				const data2 = Math.random().toString(16).substring(2, 10).toUpperCase();
				const ascii = Math.random()
					.toString(36)
					.substring(2, 10)
					.replace(/[^a-z]/g, ".");
				const line = document.createElement("div");
				line.textContent = `${addr}  ${data1} ${data2}  [${ascii}]`;
				frag.appendChild(line);
			}
		}
		hexContent.appendChild(frag);
	}

	topologyCleanup = () => {
		stopLoops();
		document.removeEventListener("visibilitychange", onVisibilityChange);
		window.removeEventListener("resize", onResize);
		if (!lowPowerMode) {
			document.removeEventListener("mousemove", onMouseMove);
			document.removeEventListener("mouseleave", onMouseLeave);
		}
	};
}

// Expose globally so theme toggle can reinitialize with correct colors
window.initLatentTopology = initLatentTopology;

if (!lifecycleBound) {
	lifecycleBound = true;
	document.addEventListener("astro:page-load", () => {
		window.initLatentTopology?.();
	});
	document.addEventListener("astro:before-swap", cleanupLatentTopology);
}

initLatentTopology();
