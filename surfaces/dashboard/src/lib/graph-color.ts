import type { SceneNode } from "./graph-scene";

export type ColorVariable = "confidence" | "importance" | "mentions" | "aspectWeight" | "created" | "updated";
export type Interpolation = "rgb" | "oklab";
export type Scale = "linear" | "sqrt" | "log";

export interface ColorConfig {
	readonly variable: ColorVariable;
	readonly stops: readonly string[];
	readonly interpolation: Interpolation;
	readonly bands: number;
	readonly gamma: number;
	readonly reverse: boolean;
	readonly scale: Scale;
	readonly auto: boolean;
	readonly min: number;
	readonly max: number;
	readonly inherit: boolean;
	readonly missing: string;
}

const VALUED_IMPORTANCE = new Set(["attribute", "claim", "constraint", "claimSlot", "group"]);
const DAY_MS = 86_400_000;

function ageInDays(time: number | undefined, now: number): number | undefined {
	return time === undefined ? undefined : Math.max(0, (now - time) / DAY_MS);
}

export const COLOR_VARIABLES: ReadonlyArray<{
	readonly key: ColorVariable;
	readonly label: string;
	readonly read: (node: SceneNode, now: number) => number | undefined;
}> = [
	{ key: "confidence", label: "Confidence", read: (node) => node.confidence },
	{
		key: "importance",
		label: "Importance",
		read: (node) => (VALUED_IMPORTANCE.has(node.kind) ? node.weight : undefined),
	},
	{ key: "mentions", label: "Mentions", read: (node) => node.mentions },
	{ key: "aspectWeight", label: "Aspect weight", read: (node) => (node.kind === "aspect" ? node.weight : undefined) },
	{ key: "created", label: "Days since created", read: (node, now) => ageInDays(node.createdAt, now) },
	{ key: "updated", label: "Days since updated", read: (node, now) => ageInDays(node.updatedAt, now) },
];

export const RAMPS: Readonly<Record<string, readonly string[]>> = {
	viridis: [
		"#440154",
		"#482878",
		"#3e4989",
		"#31688e",
		"#26828e",
		"#1f9e89",
		"#35b779",
		"#6ece58",
		"#b5de2b",
		"#fde725",
	],
	inferno: [
		"#000004",
		"#1b0c41",
		"#4a0c6b",
		"#781c6d",
		"#a52c60",
		"#cf4446",
		"#ed6925",
		"#fb9b06",
		"#f7d13d",
		"#fcffa4",
	],
	magma: ["#000004", "#180f3d", "#440f76", "#721f81", "#9e2f7f", "#cd4071", "#f1605d", "#fd9668", "#feca8d", "#fcfdbf"],
	turbo: [
		"#30123b",
		"#4145ab",
		"#4675ed",
		"#39a2fc",
		"#1bcfd4",
		"#24eca6",
		"#61fc6c",
		"#a4fc3b",
		"#d1e834",
		"#f3c63a",
		"#fe9b2d",
		"#f36315",
		"#d93806",
		"#b11901",
		"#7a0403",
	],
	"false color": [
		"#8a2be2",
		"#1e5bff",
		"#4a4a4a",
		"#6a6a6a",
		"#3fbf3f",
		"#8a8a8a",
		"#ff8fb3",
		"#b0b0b0",
		"#f2e35a",
		"#ff2a2a",
	],
	grayscale: ["#1c1c1c", "#f2f2f2"],
};

export const DEFAULT_COLOR_CONFIG: ColorConfig = {
	variable: "confidence",
	stops: RAMPS.viridis ?? [],
	interpolation: "oklab",
	bands: 0,
	gamma: 1,
	reverse: false,
	scale: "linear",
	auto: true,
	min: 0,
	max: 1,
	inherit: true,
	missing: "#3a3f4b",
};

type Rgb = readonly [number, number, number];

function parseHex(hex: string): Rgb {
	const value = hex.replace("#", "");
	const full = value.length === 3 ? [...value].map((c) => c + c).join("") : value.padEnd(6, "0");
	const n = Number.parseInt(full.slice(0, 6), 16);
	return Number.isNaN(n) ? [0, 0, 0] : [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function toHex([r, g, b]: Rgb): string {
	const channel = (v: number) =>
		Math.round(Math.min(255, Math.max(0, v)))
			.toString(16)
			.padStart(2, "0");
	return `#${channel(r)}${channel(g)}${channel(b)}`;
}

function linear(c: number): number {
	const v = c / 255;
	return v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
}

function encode(v: number): number {
	return 255 * (v <= 0.0031308 ? 12.92 * v : 1.055 * v ** (1 / 2.4) - 0.055);
}

function toOklab([r, g, b]: Rgb): Rgb {
	const lr = linear(r),
		lg = linear(g),
		lb = linear(b);
	const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
	const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
	const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
	return [
		0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s,
		1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s,
		0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s,
	];
}

function fromOklab([L, a, b]: Rgb): Rgb {
	const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3;
	const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3;
	const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
	return [
		encode(4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s),
		encode(-1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s),
		encode(-0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s),
	];
}

function mix(a: Rgb, b: Rgb, t: number): Rgb {
	return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
}

export function sampleRamp(stops: readonly string[], t: number, interpolation: Interpolation): string {
	const first = stops[0];
	if (!first) return "#000000";
	if (stops.length === 1) return first;
	const at = Math.min(1, Math.max(0, t)) * (stops.length - 1);
	const index = Math.min(stops.length - 2, Math.floor(at));
	const a = parseHex(stops[index] ?? first);
	const b = parseHex(stops[index + 1] ?? first);
	const local = at - index;
	if (interpolation === "rgb") return toHex(mix(a, b, local));
	return toHex(fromOklab(mix(toOklab(a), toOklab(b), local)));
}

export function rampPosition(config: ColorConfig, value: number, min: number, max: number): number {
	const scale = (v: number) =>
		config.scale === "log" ? Math.log1p(Math.max(0, v)) : config.scale === "sqrt" ? Math.sqrt(Math.max(0, v)) : v;
	const low = scale(min);
	const span = scale(max) - low;
	let t = span > 0 ? (scale(value) - low) / span : 0.5;
	t = Math.min(1, Math.max(0, t)) ** config.gamma;
	if (config.bands >= 2) t = Math.min(config.bands - 1, Math.floor(t * config.bands)) / (config.bands - 1);
	return config.reverse ? 1 - t : t;
}

export interface NodeColoring {
	readonly colors: ReadonlyMap<string, string>;
	readonly valued: number;
	readonly min: number;
	readonly max: number;
}

export function colorNodes(nodes: readonly SceneNode[], config: ColorConfig, now = Date.now()): NodeColoring {
	const read = COLOR_VARIABLES.find((variable) => variable.key === config.variable)?.read;
	const values = new Map<string, number>();
	const sums = new Map<string, { total: number; count: number }>();
	for (const node of nodes) {
		const value = read?.(node, now);
		if (value === undefined || !Number.isFinite(value)) continue;
		values.set(node.id, value);
		const sum = sums.get(node.cluster) ?? { total: 0, count: 0 };
		sum.total += value;
		sum.count += 1;
		sums.set(node.cluster, sum);
	}
	const own = [...values.values()];
	const min = config.auto ? Math.min(...own) : config.min;
	const max = config.auto ? Math.max(...own) : config.max;
	const colors = new Map<string, string>();
	for (const node of nodes) {
		const sum = sums.get(node.cluster);
		const value = values.get(node.id) ?? (config.inherit && sum ? sum.total / sum.count : undefined);
		colors.set(
			node.id,
			value === undefined
				? config.missing
				: sampleRamp(config.stops, rampPosition(config, value, min, max), config.interpolation),
		);
	}
	return { colors, valued: own.length, min: own.length ? min : 0, max: own.length ? max : 0 };
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isHex(value: unknown): value is string {
	return typeof value === "string" && /^#[0-9a-f]{3}([0-9a-f]{3})?$/i.test(value);
}

export function parseColorConfig(value: unknown): ColorConfig | null {
	if (!isRecord(value)) return null;
	const variable = COLOR_VARIABLES.find((entry) => entry.key === value.variable)?.key;
	const stops = Array.isArray(value.stops) ? value.stops.filter(isHex) : [];
	const number = (key: string, fallback: number) => {
		const raw = value[key];
		return typeof raw === "number" && Number.isFinite(raw) ? raw : fallback;
	};
	const flag = (key: string, fallback: boolean) => {
		const raw = value[key];
		return typeof raw === "boolean" ? raw : fallback;
	};
	if (!variable || stops.length === 0) return null;
	return {
		variable,
		stops,
		interpolation: value.interpolation === "rgb" ? "rgb" : "oklab",
		bands: Math.round(Math.min(32, Math.max(0, number("bands", 0)))),
		gamma: Math.min(8, Math.max(0.1, number("gamma", 1))),
		reverse: flag("reverse", false),
		scale: value.scale === "sqrt" || value.scale === "log" ? value.scale : flag("log", false) ? "log" : "linear",
		auto: flag("auto", true),
		min: number("min", 0),
		max: number("max", 1),
		inherit: flag("inherit", true),
		missing: isHex(value.missing) ? value.missing : DEFAULT_COLOR_CONFIG.missing,
	};
}

export type GraphColorMode = "category" | "mentions" | "age";

export const GRAPH_COLOR_MODES: ReadonlyArray<{
	readonly key: GraphColorMode;
	readonly label: string;
	readonly config: ColorConfig | null;
}> = [
	{ key: "category", label: "Category", config: null },
	{
		key: "mentions",
		label: "Mentions",
		config: {
			...DEFAULT_COLOR_CONFIG,
			variable: "mentions",
			stops: ["#1c1c1c", "#e66100", "#c01c28"],
			bands: 16,
			gamma: 1.7,
			scale: "sqrt",
		},
	},
	{
		key: "age",
		label: "Age",
		config: {
			...DEFAULT_COLOR_CONFIG,
			variable: "created",
			stops: RAMPS.turbo ?? [],
			bands: 16,
			scale: "log",
			missing: "#000000",
		},
	},
];

const PREVIEW_STEPS = 96;

export function rampGradient(config: ColorConfig, min: number, max: number): string {
	const segments: string[] = [];
	for (let i = 0; i < PREVIEW_STEPS; i++) {
		const value = min + ((max - min) * (i + 0.5)) / PREVIEW_STEPS;
		const color = sampleRamp(config.stops, rampPosition(config, value, min, max), config.interpolation);
		segments.push(`${color} ${(i / PREVIEW_STEPS) * 100}% ${((i + 1) / PREVIEW_STEPS) * 100}%`);
	}
	return `linear-gradient(to right, ${segments.join(", ")})`;
}
