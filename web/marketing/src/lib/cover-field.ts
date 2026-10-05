import sharp from "sharp";

export type CoverTone = "electric" | "night" | "paper" | "dusk";
export type CoverMotif = "burst" | "ridges" | "orbit" | "tide" | "lattice" | "path" | "horizon" | "stream" | "floor";

interface Palette {
	readonly bg: readonly [string, string];
	readonly ink: readonly [string, string, string, string];
	readonly glow: boolean;
}

const PALETTES: Record<CoverTone, Palette> = {
	electric: { bg: ["#1d44e6", "#06156b"], ink: ["#3a5ff0", "#7393fa", "#bccbff", "#f4f7ff"], glow: true },
	night: { bg: ["#0f2537", "#03090e"], ink: ["#1b3a5a", "#2f6aa3", "#71aceb", "#e2f1ff"], glow: true },
	paper: { bg: ["#eef1f5", "#cdd5e0"], ink: ["#b4bdcc", "#8492a8", "#4c5b74", "#121c2b"], glow: false },
	dusk: { bg: ["#1d1950", "#06071a"], ink: ["#2d307c", "#4c52c4", "#929aff", "#eceeff"], glow: true },
};

interface Field {
	readonly value: (x: number, y: number) => number;
	readonly focus: readonly [number, number];
}

type Motif = (next: () => number, seed: number, w: number, h: number) => Field;

function seedFrom(text: string): number {
	let hash = 2166136261;
	for (let i = 0; i < text.length; i++) {
		hash ^= text.charCodeAt(i);
		hash = Math.imul(hash, 16777619);
	}
	return hash >>> 0;
}

function random(seed: number): () => number {
	let state = seed;
	return () => {
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

function lattice(seed: number, ix: number, iy: number): number {
	let h = Math.imul(ix, 374761393) + Math.imul(iy, 668265263) + seed;
	h = Math.imul(h ^ (h >>> 13), 1274126177);
	return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function noise(seed: number, x: number, y: number): number {
	const ix = Math.floor(x);
	const iy = Math.floor(y);
	const sx = (x - ix) ** 2 * (3 - 2 * (x - ix));
	const sy = (y - iy) ** 2 * (3 - 2 * (y - iy));
	const top = lattice(seed, ix, iy) + (lattice(seed, ix + 1, iy) - lattice(seed, ix, iy)) * sx;
	const bottom = lattice(seed, ix, iy + 1) + (lattice(seed, ix + 1, iy + 1) - lattice(seed, ix, iy + 1)) * sx;
	return top + (bottom - top) * sy;
}

function fbm(seed: number, x: number, y: number): number {
	return 0.55 * noise(seed, x, y) + 0.3 * noise(seed + 1, x * 2.1, y * 2.1) + 0.15 * noise(seed + 2, x * 4.3, y * 4.3);
}

function gauss(distance: number, width: number): number {
	const d = distance / width;
	return Math.exp(-d * d);
}

function segmentDistance(px: number, py: number, ax: number, ay: number, bx: number, by: number): number {
	const dx = bx - ax;
	const dy = by - ay;
	const t = Math.max(0, Math.min(1, ((px - ax) * dx + (py - ay) * dy) / (dx * dx + dy * dy || 1)));
	return Math.hypot(px - (ax + t * dx), py - (ay + t * dy));
}
const burst: Motif = (next, seed, w, h) => {
	const cx = w * (0.58 + next() * 0.2);
	const cy = h * (0.42 + next() * 0.2);
	const spokes = 7 + Math.floor(next() * 6);
	return {
		focus: [cx, cy],
		value: (x, y) => {
			const d = Math.hypot(x - cx, y - cy);
			const angle = Math.atan2(y - cy, x - cx);
			let v = gauss(d, h * 0.13) + 0.22 * gauss(d, h * 0.7);
			for (let k = 0; k < 7; k++) {
				const ring = gauss(d - h * (0.2 + k * 0.105), h * 0.016) * (1 - k / 8);
				v = Math.max(v, ring * (0.55 + 0.45 * fbm(seed + k, Math.cos(angle) * 2 + k, Math.sin(angle) * 2)));
			}
			return v + Math.max(0, Math.cos(angle * spokes)) ** 12 * gauss(d, h * 0.9) * 0.35;
		},
	};
};
const ridges: Motif = (next, seed, w, h) => {
	const count = 11;
	const cx = w * (0.4 + next() * 0.3);
	const spread = w * (0.18 + next() * 0.12);
	const amp = h * (0.22 + next() * 0.12);
	const crest = (x: number, k: number): number =>
		h * (0.3 + (k / (count - 1)) * 0.56) -
		amp * gauss(x - cx, spread) * (0.35 + 1.1 * fbm(seed, x / (w * 0.16), k * 0.12));
	return {
		focus: [cx, h * 0.45],
		value: (x, y) => {
			let v = 0;
			let ceiling = Number.POSITIVE_INFINITY;
			for (let k = count - 1; k >= 0; k--) {
				const top = crest(x, k);
				if (top > ceiling - h * 0.012) continue;
				ceiling = top;
				v = Math.max(v, gauss(y - top, h * 0.01) * (0.3 + 0.7 * gauss(x - cx, spread * 1.3)));
			}
			return v;
		},
	};
};
const orbit: Motif = (next, _seed, w, h) => {
	const cx = w * (0.45 + next() * 0.2);
	const cy = h * (0.45 + next() * 0.1);
	const tilt = (next() - 0.5) * 0.7;
	const cos = Math.cos(tilt);
	const sin = Math.sin(tilt);
	const rings = Array.from({ length: 5 }, (_, k) => {
		const rx = w * (0.12 + k * 0.085);
		const angle = next() * Math.PI * 2;
		return { rx, ry: rx * 0.34, sx: Math.cos(angle) * rx, sy: Math.sin(angle) * rx * 0.34 };
	});
	return {
		focus: [cx, cy],
		value: (x, y) => {
			const dx = x - cx;
			const dy = y - cy;
			const ex = dx * cos + dy * sin;
			const ey = -dx * sin + dy * cos;
			let v = gauss(Math.hypot(dx, dy), h * 0.08) + 0.25 * gauss(Math.hypot(dx, dy), h * 0.3);
			for (const ring of rings) {
				const q = Math.hypot(ex / ring.rx, ey / ring.ry) || 1;
				const d = Math.abs(q - 1) * (Math.hypot(ex, ey) / q);
				v = Math.max(v, 0.75 * gauss(d, h * 0.009), gauss(Math.hypot(ex - ring.sx, ey - ring.sy), h * 0.022));
			}
			return v;
		},
	};
};
const tide: Motif = (next, _seed, w, h) => {
	const a = { x: w * (0.12 + next() * 0.25), y: h * (0.15 + next() * 0.7) };
	const b = { x: w * (0.62 + next() * 0.25), y: h * (0.15 + next() * 0.7) };
	const wave = h * (0.075 + next() * 0.03);
	const ring = (d: number): number => {
		const r = d % wave;
		return gauss(Math.min(r, wave - r), h * 0.008) * gauss(d, w * 0.38);
	};
	return {
		focus: [(a.x + b.x) / 2, (a.y + b.y) / 2],
		value: (x, y) => {
			const da = Math.hypot(x - a.x, y - a.y);
			const db = Math.hypot(x - b.x, y - b.y);
			const la = ring(da);
			const lb = ring(db);
			return Math.max(0.6 * Math.max(la, lb), Math.min(1, la * lb * 2.2), gauss(Math.min(da, db), h * 0.035));
		},
	};
};
const graph: Motif = (next, _seed, w, h) => {
	const nodes = Array.from({ length: 13 }, () => ({
		x: w * (0.08 + next() * 0.84),
		y: h * (0.14 + next() * 0.72),
		size: h * (0.02 + next() * 0.035),
	}));
	const edges: Array<readonly [number, number]> = [];
	nodes.forEach((node, i) => {
		const nearest = nodes
			.map((other, j) => ({ j, d: Math.hypot(other.x - node.x, other.y - node.y) }))
			.filter((c) => c.j !== i)
			.sort((a, b) => a.d - b.d)
			.slice(0, 2);
		for (const c of nearest) edges.push([i, c.j]);
	});
	const hub = nodes.reduce((best, node) => (node.size > best.size ? node : best));
	return {
		focus: [hub.x, hub.y],
		value: (x, y) => {
			let v = 0;
			for (const node of nodes) {
				const d = Math.hypot(x - node.x, y - node.y);
				v = Math.max(v, gauss(d, node.size), 0.3 * gauss(d, node.size * 4));
			}
			for (const [a, b] of edges) {
				const na = nodes[a];
				const nb = nodes[b];
				if (na && nb) v = Math.max(v, 0.6 * gauss(segmentDistance(x, y, na.x, na.y, nb.x, nb.y), h * 0.012));
			}
			return v;
		},
	};
};
const route: Motif = (next, _seed, w, h) => {
	const points = Array.from({ length: 6 }, (_, i) => ({ x: w * (-0.05 + i * 0.22), y: h * (0.25 + next() * 0.5) }));
	const samples: Array<readonly [number, number]> = [];
	for (let i = 0; i < points.length - 1; i++) {
		const p0 = points[Math.max(0, i - 1)];
		const p1 = points[i];
		const p2 = points[i + 1];
		const p3 = points[Math.min(points.length - 1, i + 2)];
		if (!p0 || !p1 || !p2 || !p3) continue;
		for (let t = 0; t < 1; t += 0.04) {
			const spline = (a: number, b: number, c: number, d: number): number =>
				0.5 * (2 * b + (-a + c) * t + (2 * a - 5 * b + 4 * c - d) * t ** 2 + (-a + 3 * b - 3 * c + d) * t ** 3);
			samples.push([spline(p0.x, p1.x, p2.x, p3.x), spline(p0.y, p1.y, p2.y, p3.y)]);
		}
	}
	const stops = points.slice(1, -1);
	const focus = stops[Math.floor(stops.length / 2)] ?? { x: w / 2, y: h / 2 };
	return {
		focus: [focus.x, focus.y],
		value: (x, y) => {
			let d = Number.POSITIVE_INFINITY;
			for (let i = 0; i < samples.length - 1; i++) {
				const a = samples[i];
				const b = samples[i + 1];
				if (a && b) d = Math.min(d, segmentDistance(x, y, a[0], a[1], b[0], b[1]));
			}
			let v = Math.max(gauss(d, h * 0.016), 0.28 * gauss(d, h * 0.09));
			for (const stop of stops) {
				const s = Math.hypot(x - stop.x, y - stop.y);
				v = Math.max(v, gauss(s, h * 0.035), 0.8 * gauss(s - h * 0.075, h * 0.01));
			}
			return v;
		},
	};
};
const stream: Motif = (next, seed, w, h) => {
	const ribbons = Array.from({ length: 9 }, (_, i) => ({
		base: h * (0.5 + (i - 4) * 0.06 + (next() - 0.5) * 0.05),
		slope: ((0.45 + next() * 0.12) * h) / w,
		amp: h * (0.04 + next() * 0.07),
		freq: (Math.PI * 2 * (0.5 + next() * 0.6)) / w,
		phase: next() * Math.PI * 2,
		width: h * (i === 4 ? 0.022 : 0.006 + next() * 0.02),
		gain: i === 4 ? 0.85 : 0.18 + next() * 0.32,
	}));
	return {
		focus: [w * 0.25, h * 0.4],
		value: (x, y) => {
			let v = 0;
			for (const r of ribbons) {
				const center = r.base + r.slope * (x - w / 2) + r.amp * Math.sin(r.freq * x + r.phase);
				v += r.gain * gauss(y - center, r.width * (0.6 + 0.8 * fbm(seed, x / (w * 0.04), r.phase)));
			}
			const sparkle = fbm(seed + 9, x / (w * 0.008), y / (h * 0.02));
			const haze =
				0.1 * fbm(seed + 3, x / (w * 0.15), y / (h * 0.25)) * gauss(y - h * 0.5 - 0.2 * (x - w / 2), h * 0.4);
			return Math.min(1, v * (0.3 + 1.1 * sparkle ** 3) + haze);
		},
	};
};
const floor: Motif = (_next, seed, w, h) => {
	const hy = h * 0.3;
	const cx = w / 2;
	return {
		focus: [cx, hy],
		value: (x, y) => {
			const glow = 0.85 * gauss(y - hy, h * 0.035) * gauss(x - cx, w * 0.28);
			if (y < hy) return glow;
			const d = (y - hy) / (h - hy);
			const depth = 1 / Math.max(d, 0.02);
			const gx = ((x - cx) / w) * depth * 7;
			const gz = depth * 1.2;
			const lineX = gauss(gx - Math.round(gx), 0.03 * depth ** 0.55);
			const lineZ = gauss(gz - Math.round(gz), 0.035 * depth ** 0.65);
			const fade = Math.min(1, d * 4) * (1 - d) ** 1.6 * gauss(x - cx, w * (0.18 + 0.2 * d));
			const sparkle = 0.6 + 0.6 * fbm(seed, x / (w * 0.02), y / (h * 0.03));
			return Math.min(1, Math.max(lineX, lineZ) * fade * sparkle * 0.75 + glow);
		},
	};
};
const horizon: Motif = (_next, seed, w, h) => {
	const radius = w * 0.95;
	const cx = w * 0.5;
	const cy = h * 0.62 + radius;
	return {
		focus: [cx, h * 0.62],
		value: (x, y) => {
			const edge = Math.hypot(x - cx, y - cy) - radius;
			const rim = gauss(edge, h * 0.018);
			const haze = edge > 0 ? 0.55 * gauss(edge, h * 0.22) : 0;
			const surface = edge < 0 ? (0.18 + 0.35 * fbm(seed, x / (w * 0.06), y / (h * 0.12))) * gauss(edge, h * 0.5) : 0;
			const cell = h / 64;
			const star =
				edge > h * 0.12 && lattice(seed, Math.round(x / cell), Math.round(y / (cell * 0.87))) > 0.9965 ? 0.75 : 0;
			return Math.max(rim, haze, surface, star) * (0.6 + 0.4 * gauss(x - cx, w * 0.35));
		},
	};
};

const MOTIFS: Record<CoverMotif, Motif> = {
	burst,
	ridges,
	orbit,
	tide,
	lattice: graph,
	path: route,
	horizon,
	stream,
	floor,
};

function circle(x: number, y: number, r: number): string {
	return `M${(x - r).toFixed(1)} ${y.toFixed(1)}a${r.toFixed(1)} ${r.toFixed(1)} 0 1 0 ${(2 * r).toFixed(1)} 0a${r.toFixed(1)} ${r.toFixed(1)} 0 1 0 ${(-2 * r).toFixed(1)} 0`;
}

export async function renderArt(
	seedText: string,
	motif: CoverMotif,
	tone: CoverTone,
	width: number,
	height: number,
	transparent = false,
	rows = 64,
): Promise<Buffer> {
	const seed = seedFrom(seedText);
	const palette = PALETTES[tone];
	const field = MOTIFS[motif](random(seed), seed, width, height);
	const step = Math.max(4, Math.round(height / rows));
	const bins: string[][] = [[], [], [], []];
	for (let row = 0; row * step * 0.87 < height + step; row++) {
		const y = row * step * 0.87;
		for (let x = row % 2 ? step / 2 : 0; x < width + step; x += step) {
			const grain = (lattice(seed + 7, Math.round(x), Math.round(y)) - 0.5) * 0.08;
			const v = Math.min(1, Math.max(0, field.value(x, y) + grain));
			const r = step * 0.52 * Math.sqrt(v);
			if (r < step * 0.07 || (transparent && v < 0.1)) continue;
			bins[Math.min(3, Math.floor(v * 4))]?.push(circle(x, y, r));
		}
	}

	const [fx, fy] = field.focus;
	const dots = bins.map((paths, i) => `<path fill="${palette.ink[i]}" d="${paths.join("")}"/>`).join("");
	const glow = palette.glow
		? `<g filter="url(#blur)" opacity="0.75"><path fill="${palette.ink[2]}" d="${bins[2]?.join("")}"/><path fill="${palette.ink[3]}" d="${bins[3]?.join("")}"/></g>`
		: "";
	const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}" viewBox="0 0 ${width} ${height}"><defs><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" stop-color="${palette.bg[0]}"/><stop offset="1" stop-color="${palette.bg[1]}"/></linearGradient><radialGradient id="halo" gradientUnits="userSpaceOnUse" cx="${fx}" cy="${fy}" r="${width * 0.6}"><stop offset="0" stop-color="${palette.ink[2]}" stop-opacity="${palette.glow ? 0.2 : 0.12}"/><stop offset="0.35" stop-color="${palette.ink[2]}" stop-opacity="${palette.glow ? 0.07 : 0.04}"/><stop offset="1" stop-color="${palette.ink[2]}" stop-opacity="0"/></radialGradient><filter id="blur" x="-10%" y="-10%" width="120%" height="120%"><feGaussianBlur stdDeviation="${step * 0.9}"/></filter></defs>${transparent ? "" : `<rect width="${width}" height="${height}" fill="url(#bg)"/><rect width="${width}" height="${height}" fill="url(#halo)"/>`}${glow}${dots}</svg>`;
	const webp = transparent ? { quality: 62, alphaQuality: 50, effort: 6 } : { quality: 88, effort: 5 };
	return sharp(Buffer.from(svg)).webp(webp).toBuffer();
}
