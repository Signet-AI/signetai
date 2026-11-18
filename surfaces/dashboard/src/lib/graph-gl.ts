import { DOT_SIDE, type GraphPainter, PAINT_SHAPES, type PaintView } from "./graph-paint";

const SEGMENT_STRIDE = 9;
const SHAPE_STRIDE = 8;
const RAW_STRIDE = 6;
const ANALYTIC_STRIDE = 10;
const SEGMENT = 0;
const SHAPE = 1;
const RAW = 2;
const LINE = 3;
const RECT = 4;
const MAX_SAMPLES = 8;
const CIRCLE = PAINT_SHAPES.indexOf("circle");
const SQUARE = PAINT_SHAPES.indexOf("square");
const DOT = PAINT_SHAPES.indexOf("dot");

type Tint = readonly [number, number, number];
interface Template {
	readonly buffer: WebGLBuffer;
	readonly vertices: number;
}
interface Op {
	readonly kind: number;
	readonly first: number;
	count: number;
	readonly stencil: number;
	readonly template?: Template;
}

const HEADER = `#version 300 es
precision highp float;
uniform vec2 pan;
uniform float zoom;
uniform float ratio;
uniform vec2 size;
vec4 clip(vec2 device) {
	return vec4(device / size * 2.0 - 1.0, 0.0, 1.0);
}
vec2 project(vec2 world) {
	return (world * zoom + pan) * ratio;
}
`;

const SOLID_FRAGMENT = `#version 300 es
precision highp float;
flat in vec4 tint;
out vec4 result;
void main() {
	result = vec4(tint.rgb * tint.a, tint.a);
}
`;

const SEGMENT_VERTEX = `${HEADER}
layout(location = 0) in vec2 corner;
layout(location = 1) in vec4 segment;
layout(location = 2) in float width;
layout(location = 3) in vec4 color;
flat out vec4 tint;
void main() {
	vec2 a = project(segment.xy);
	vec2 b = project(segment.zw);
	vec2 delta = b - a;
	float span = length(delta);
	vec2 along = span > 0.0 ? delta / span : vec2(1.0, 0.0);
	vec2 across = vec2(-along.y, along.x);
	tint = color;
	gl_Position = clip(a + along * (corner.x * span) + across * (corner.y * width * ratio * 0.5));
}
`;

const SHAPE_VERTEX = `${HEADER}
layout(location = 0) in vec4 outline;
layout(location = 1) in vec4 body;
layout(location = 2) in vec4 color;
flat out vec4 tint;
void main() {
	tint = color;
	gl_Position = clip(project(body.xy) + outline.xy * (body.z * zoom * ratio) + outline.zw * (body.w * ratio * 0.5));
}
`;

const RAW_VERTEX = `${HEADER}
layout(location = 0) in vec2 position;
layout(location = 1) in vec4 color;
flat out vec4 tint;
void main() {
	tint = color;
	gl_Position = clip(position);
}
`;

const LINE_VERTEX = `${HEADER}
layout(location = 0) in vec2 corner;
layout(location = 1) in vec4 segment;
layout(location = 2) in vec2 shape;
layout(location = 3) in vec4 color;
out vec2 local;
flat out vec3 frame;
flat out vec4 tint;
void main() {
	vec2 a = project(segment.xy);
	vec2 b = project(segment.zw);
	vec2 delta = b - a;
	float span = length(delta);
	vec2 along = span > 0.0 ? delta / span : vec2(1.0, 0.0);
	vec2 across = vec2(-along.y, along.x);
	float half_ = shape.y * ratio * 0.5;
	float u = corner.x * (span + 4.0) - 2.0;
	float v = corner.y * (half_ + 2.0);
	local = vec2(u, v);
	frame = vec3(span, half_, abs(along.x) + abs(along.y));
	tint = color;
	gl_Position = clip(a + along * u + across * v);
}
`;

const LINE_FRAGMENT = `#version 300 es
precision highp float;
in vec2 local;
flat in vec3 frame;
flat in vec4 tint;
out vec4 result;
float edges(float near, float far, float scale) {
	return clamp(clamp(near / scale + 0.5, 0.0, 1.0) + clamp(far / scale + 0.5, 0.0, 1.0) - 1.0, 0.0, 1.0);
}
void main() {
	float span = frame.x;
	float half_ = frame.y;
	float scale = frame.z;
	float across = half_ <= 0.5
		? half_ * 2.0 * max(0.0, 1.0 - abs(local.y) / scale) / scale
		: edges(half_ - local.y, half_ + local.y, scale);
	float alpha = tint.a * edges(local.x, span - local.x, scale) * across;
	result = vec4(tint.rgb * alpha, alpha);
}
`;

const RECT_VERTEX = `${HEADER}
layout(location = 0) in vec2 corner;
layout(location = 1) in vec4 geometry;
layout(location = 2) in vec2 shape;
layout(location = 3) in vec4 color;
out vec2 local;
flat out vec4 box;
flat out vec4 tint;
void main() {
	vec2 low = project(geometry.xy);
	vec2 high = project(geometry.xy + geometry.zw);
	vec2 position = mix(low - 1.0, high + 1.0, vec2(corner.x, corner.y * 0.5 + 0.5));
	local = position;
	box = vec4(low, high);
	tint = color;
	gl_Position = clip(position);
}
`;

const RECT_FRAGMENT = `#version 300 es
precision highp float;
in vec2 local;
flat in vec4 box;
flat in vec4 tint;
out vec4 result;
float overlap(float lo, float hi, float a, float b) {
	return max(0.0, min(hi, b) - max(lo, a));
}
void main() {
	float alpha = tint.a
		* overlap(local.x - 0.5, local.x + 0.5, box.x, box.z)
		* overlap(local.y - 0.5, local.y + 0.5, box.y, box.w);
	result = vec4(tint.rgb * alpha, alpha);
}
`;

const COPY_VERTEX = `#version 300 es
const vec2 corners[3] = vec2[3](vec2(-1.0, -1.0), vec2(3.0, -1.0), vec2(-1.0, 3.0));
out vec2 uv;
void main() {
	vec2 corner = corners[gl_VertexID];
	uv = corner * 0.5 + 0.5;
	gl_Position = vec4(corner.x, -corner.y, 0.0, 1.0);
}
`;

const COPY_FRAGMENT = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D frame;
out vec4 result;
void main() {
	result = texture(frame, uv);
}
`;

function compile(gl: WebGL2RenderingContext, vertex: string, fragment: string): WebGLProgram {
	const program = gl.createProgram();
	for (const [type, source] of [
		[gl.VERTEX_SHADER, vertex],
		[gl.FRAGMENT_SHADER, fragment],
	] as const) {
		const shader = gl.createShader(type);
		if (!shader) throw new Error("WebGL shader is unavailable");
		gl.shaderSource(shader, source);
		gl.compileShader(shader);
		if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader) ?? "shader");
		gl.attachShader(program, shader);
	}
	gl.linkProgram(program);
	if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program) ?? "program");
	return program;
}

class Stream {
	data: Float32Array;
	count = 0;
	constructor(readonly stride: number) {
		this.data = new Float32Array(stride * 1024);
	}
	reserve(more: number): number {
		const needed = (this.count + more) * this.stride;
		if (needed > this.data.length) {
			const grown = new Float32Array(Math.max(needed, this.data.length * 2));
			grown.set(this.data.subarray(0, this.count * this.stride));
			this.data = grown;
		}
		const at = this.count * this.stride;
		this.count += more;
		return at;
	}
}

const rgbCache = new Map<string, Tint>();
function rgb(color: string): Tint {
	const cached = rgbCache.get(color);
	if (cached) return cached;
	const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1];
	if (!hex) throw new Error(`Unsupported graph color ${color}`);
	const value = Number.parseInt(hex, 16);
	const parsed = [((value >> 16) & 255) / 255, ((value >> 8) & 255) / 255, (value & 255) / 255] as const;
	rgbCache.set(color, parsed);
	return parsed;
}

export function curveSegments(deviceRadius: number): number {
	return Math.max(1, Math.ceil(Math.sqrt(Math.max(0, 2 * deviceRadius - 0.2071))));
}

export function fillSegments(deviceRadius: number): number {
	return 2 ** Math.ceil(Math.log2(curveSegments(deviceRadius)));
}

function circlePoints(segments: number): Array<readonly [number, number]> {
	const weight = Math.SQRT1_2;
	const points: Array<readonly [number, number]> = [];
	for (let quarter = 0; quarter < 4; quarter++) {
		const angle = (quarter * Math.PI) / 2;
		const x0 = Math.cos(angle);
		const y0 = Math.sin(angle);
		const x2 = Math.cos(angle + Math.PI / 2);
		const y2 = Math.sin(angle + Math.PI / 2);
		for (let step = 0; step < segments; step++) {
			const t = step / segments;
			const b0 = (1 - t) * (1 - t);
			const b1 = 2 * weight * t * (1 - t);
			const b2 = t * t;
			const total = b0 + b1 + b2;
			points.push([(b0 * x0 + b1 * (x0 + x2) + b2 * x2) / total, (b0 * y0 + b1 * (y0 + y2) + b2 * y2) / total]);
		}
	}
	return points;
}

function polygon(shape: number): Array<readonly [number, number]> {
	const name = PAINT_SHAPES[shape];
	const box = (half: number): Array<readonly [number, number]> => [
		[-half, -half],
		[half, -half],
		[half, half],
		[-half, half],
	];
	if (name === "square") return box(0.85);
	if (name === "dot") return box(DOT_SIDE / 2);
	if (name === "hexagon")
		return Array.from({ length: 6 }, (_, side) => {
			const angle = (Math.PI / 3) * side + Math.PI / 6;
			return [Math.cos(angle) * 1.1, Math.sin(angle) * 1.1] as const;
		});
	if (name === "diamond")
		return [
			[0, -1.25],
			[1.25, 0],
			[0, 1.25],
			[-1.25, 0],
		];
	return [
		[0, -1.3],
		[1.2, 0.8],
		[-1.2, 0.8],
	];
}

function fan(points: ReadonlyArray<readonly [number, number]>): Float32Array {
	const out: number[] = [];
	for (const [index, [ax, ay]] of points.entries()) {
		const [bx, by] = points[(index + 1) % points.length] ?? [0, 0];
		out.push(0, 0, 0, 0, ax, ay, 0, 0, bx, by, 0, 0);
	}
	return new Float32Array(out);
}

function annulus(points: ReadonlyArray<readonly [number, number]>): Float32Array {
	const out: number[] = [];
	for (const [index, [ax, ay]] of points.entries()) {
		const [bx, by] = points[(index + 1) % points.length] ?? [0, 0];
		out.push(ax, ay, ax, ay, bx, by, bx, by, bx, by, -bx, -by);
		out.push(ax, ay, ax, ay, bx, by, -bx, -by, ax, ay, -ax, -ay);
	}
	return new Float32Array(out);
}

function outline(points: ReadonlyArray<readonly [number, number]>): Float32Array {
	const out: number[] = [];
	const count = points.length;
	const area = points.reduce((sum, [x, y], index) => {
		const [nx, ny] = points[(index + 1) % count] ?? [0, 0];
		return sum + x * ny - nx * y;
	}, 0);
	const normals = points.map(([x, y], index) => {
		const [nx, ny] = points[(index + 1) % count] ?? [0, 0];
		const length = Math.hypot(nx - x, ny - y);
		const dx = (nx - x) / length;
		const dy = (ny - y) / length;
		return area > 0 ? ([dy, -dx] as const) : ([-dy, dx] as const);
	});
	for (const [index, [ax, ay]] of points.entries()) {
		const [bx, by] = points[(index + 1) % count] ?? [0, 0];
		const [nx, ny] = normals[index] ?? [0, 0];
		out.push(ax, ay, nx, ny, bx, by, nx, ny, bx, by, -nx, -ny);
		out.push(ax, ay, nx, ny, bx, by, -nx, -ny, ax, ay, -nx, -ny);
	}
	for (const [index, [vx, vy]] of points.entries()) {
		const [px, py] = normals[(index + count - 1) % count] ?? [0, 0];
		const [qx, qy] = normals[index] ?? [0, 0];
		const length = Math.hypot(px + qx, py + qy);
		const mx = (px + qx) / length;
		const my = (py + qy) / length;
		const cos = mx * qx + my * qy;
		out.push(vx, vy, 0, 0, vx, vy, px, py, vx, vy, mx / cos, my / cos);
		out.push(vx, vy, 0, 0, vx, vy, mx / cos, my / cos, vx, vy, qx, qy);
	}
	return new Float32Array(out);
}

function unit(x: number, y: number): readonly [number, number] {
	const length = Math.hypot(x, y) || 1;
	return [x / length, y / length];
}

export function glPainter(canvas: HTMLCanvasElement | OffscreenCanvas): GraphPainter | undefined {
	const gl = canvas.getContext("webgl2", {
		alpha: true,
		premultipliedAlpha: true,
		antialias: false,
		depth: false,
		stencil: false,
		preserveDrawingBuffer: false,
	}) as WebGL2RenderingContext | null;
	if (!gl) return undefined;
	const samples = Math.min(MAX_SAMPLES, gl.getParameter(gl.MAX_SAMPLES) as number);
	const programs = [
		compile(gl, SEGMENT_VERTEX, SOLID_FRAGMENT),
		compile(gl, SHAPE_VERTEX, SOLID_FRAGMENT),
		compile(gl, RAW_VERTEX, SOLID_FRAGMENT),
		compile(gl, LINE_VERTEX, LINE_FRAGMENT),
		compile(gl, RECT_VERTEX, RECT_FRAGMENT),
	];
	const copy = compile(gl, COPY_VERTEX, COPY_FRAGMENT);
	const activate = gl.useProgram.bind(gl);
	const uniforms = programs.map((program) => ({
		pan: gl.getUniformLocation(program, "pan"),
		zoom: gl.getUniformLocation(program, "zoom"),
		ratio: gl.getUniformLocation(program, "ratio"),
		size: gl.getUniformLocation(program, "size"),
	}));
	const quad = gl.createBuffer();
	gl.bindBuffer(gl.ARRAY_BUFFER, quad);
	gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([0, -1, 1, -1, 0, 1, 1, 1]), gl.STATIC_DRAW);
	const streams = [
		new Stream(SEGMENT_STRIDE),
		new Stream(SHAPE_STRIDE),
		new Stream(RAW_STRIDE),
		new Stream(ANALYTIC_STRIDE),
		new Stream(ANALYTIC_STRIDE),
	];
	const buffers = streams.map(() => gl.createBuffer());
	const layouts: ReadonlyArray<ReadonlyArray<readonly [number, number]>> = [
		[
			[1, 4],
			[2, 1],
			[3, 4],
		],
		[
			[1, 4],
			[2, 4],
		],
		[
			[0, 2],
			[1, 4],
		],
		[
			[1, 4],
			[2, 2],
			[3, 4],
		],
		[
			[1, 4],
			[2, 2],
			[3, 4],
		],
	];
	const vao = gl.createVertexArray();
	const upload = (data: Float32Array): Template => {
		const buffer = gl.createBuffer();
		gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
		gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
		return { buffer, vertices: data.length / 4 };
	};
	const fills = new Map<number, Template>();
	const strokes = new Map<number, Template>();
	const fillTemplate = (shape: number, deviceRadius: number) => {
		const segments = shape === CIRCLE ? fillSegments(deviceRadius) : 0;
		const key = segments * 16 + shape;
		let made = fills.get(key);
		if (!made) {
			made = upload(fan(shape === CIRCLE ? circlePoints(segments) : polygon(shape)));
			fills.set(key, made);
		}
		return made;
	};
	const strokeTemplate = (shape: number, deviceRadius: number) => {
		const segments = shape === CIRCLE ? curveSegments(deviceRadius) : 0;
		const key = segments * 16 + shape;
		let made = strokes.get(key);
		if (!made) {
			made = upload(shape === CIRCLE ? annulus(circlePoints(segments)) : outline(polygon(shape)));
			strokes.set(key, made);
		}
		return made;
	};

	let surface:
		| {
				readonly width: number;
				readonly height: number;
				readonly frame: WebGLFramebuffer;
				readonly resolve: WebGLFramebuffer;
				readonly texture: WebGLTexture;
				readonly storage: readonly WebGLRenderbuffer[];
		  }
		| undefined;
	const target = () => {
		const width = canvas.width;
		const height = canvas.height;
		if (surface && surface.width === width && surface.height === height) return surface;
		if (surface) {
			gl.deleteFramebuffer(surface.frame);
			gl.deleteFramebuffer(surface.resolve);
			gl.deleteTexture(surface.texture);
			for (const storage of surface.storage) gl.deleteRenderbuffer(storage);
		}
		const color = gl.createRenderbuffer();
		gl.bindRenderbuffer(gl.RENDERBUFFER, color);
		gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.RGBA8, width, height);
		const stencil = gl.createRenderbuffer();
		gl.bindRenderbuffer(gl.RENDERBUFFER, stencil);
		gl.renderbufferStorageMultisample(gl.RENDERBUFFER, samples, gl.STENCIL_INDEX8, width, height);
		const frame = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, frame);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, color);
		gl.framebufferRenderbuffer(gl.FRAMEBUFFER, gl.STENCIL_ATTACHMENT, gl.RENDERBUFFER, stencil);
		const texture = gl.createTexture();
		gl.bindTexture(gl.TEXTURE_2D, texture);
		gl.texStorage2D(gl.TEXTURE_2D, 1, gl.RGBA8, width, height);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
		gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
		const resolve = gl.createFramebuffer();
		gl.bindFramebuffer(gl.FRAMEBUFFER, resolve);
		gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
		surface = { width, height, frame, resolve, texture, storage: [color, stencil] };
		return surface;
	};
	const ops: Op[] = [];
	let stencils = 0;
	let view: PaintView = { ratio: 1, panX: 0, panY: 0, zoom: 1 };
	const stream = (kind: number) => streams[kind] ?? new Stream(1);
	const push = (kind: number, more: number, stencil: number, shape?: Template) => {
		const at = stream(kind).reserve(more);
		const last = ops[ops.length - 1];
		if (last && last.kind === kind && last.stencil === stencil && last.template === shape) last.count += more;
		else
			ops.push({ kind, first: at / stream(kind).stride, count: more, stencil, ...(shape ? { template: shape } : {}) });
		return at;
	};
	const segment = (stencil: number, coords: readonly number[], width: number, tint: Tint, alpha: number) => {
		const at = push(SEGMENT, 1, stencil);
		stream(SEGMENT).data.set([...coords, width, tint[0], tint[1], tint[2], alpha], at);
	};
	const analytic = (kind: number, geometry: readonly number[], width: number, tint: Tint, alpha: number) => {
		const at = push(kind, 1, 0);
		stream(kind).data.set([...geometry, 0, width, tint[0], tint[1], tint[2], alpha], at);
	};
	const device = (x: number, y: number) =>
		[(x * view.zoom + view.panX) * view.ratio, (y * view.zoom + view.panY) * view.ratio] as const;
	const triangles = (stencil: number, points: ReadonlyArray<readonly [number, number]>, tint: Tint, alpha: number) => {
		const at = push(RAW, points.length, stencil);
		const data = stream(RAW).data;
		for (const [index, [x, y]] of points.entries())
			data.set([x, y, tint[0], tint[1], tint[2], alpha], at + index * RAW_STRIDE);
	};
	const shapes = (
		points: Float64Array,
		count: number,
		pick: (shape: number, deviceRadius: number) => Template,
		width: number,
		tint: Tint,
		alpha: number,
		stencil: number,
	) => {
		const groups = new Map<Template, number[]>();
		const scale = view.zoom * view.ratio;
		for (let index = 0; index < count; index++) {
			const shape = pick(points[index * 4 + 3] ?? 0, (points[index * 4 + 2] ?? 0) * scale);
			const list = groups.get(shape);
			if (list) list.push(index);
			else groups.set(shape, [index]);
		}
		for (const [shape, members] of groups) {
			const at = push(SHAPE, members.length, stencil, shape);
			const data = stream(SHAPE).data;
			for (const [offset, index] of members.entries()) {
				const to = at + offset * SHAPE_STRIDE;
				data[to] = points[index * 4] ?? 0;
				data[to + 1] = points[index * 4 + 1] ?? 0;
				data[to + 2] = points[index * 4 + 2] ?? 0;
				data[to + 3] = width;
				data[to + 4] = tint[0];
				data[to + 5] = tint[1];
				data[to + 6] = tint[2];
				data[to + 7] = alpha;
			}
		}
	};
	const nextStencil = () => ++stencils;
	return {
		begin(next) {
			view = next;
			ops.length = 0;
			stencils = 0;
			for (const each of streams) each.count = 0;
		},
		lines(segments, count, color, alpha, width) {
			if (count <= 0) return;
			const tint = rgb(color);
			if (count === 1) {
				analytic(LINE, [segments[0] ?? 0, segments[1] ?? 0, segments[2] ?? 0, segments[3] ?? 0], width, tint, alpha);
				return;
			}
			const at = push(SEGMENT, count, nextStencil());
			const data = stream(SEGMENT).data;
			for (let index = 0; index < count; index++) {
				const to = at + index * SEGMENT_STRIDE;
				data[to] = segments[index * 4] ?? 0;
				data[to + 1] = segments[index * 4 + 1] ?? 0;
				data[to + 2] = segments[index * 4 + 2] ?? 0;
				data[to + 3] = segments[index * 4 + 3] ?? 0;
				data[to + 4] = width;
				data[to + 5] = tint[0];
				data[to + 6] = tint[1];
				data[to + 7] = tint[2];
				data[to + 8] = alpha;
			}
		},
		highlight(x0, y0, x1, y1, arrow, color, alpha, width) {
			const tint = rgb(color);
			if (!arrow) {
				analytic(LINE, [x0, y0, x1, y1], width, tint, alpha);
				return;
			}
			const stencil = nextStencil();
			segment(stencil, [x0, y0, x1, y1], width, tint, alpha);
			const [ax = 0, ay = 0, tx = 0, ty = 0, bx = 0, by = 0] = arrow;
			segment(stencil, [ax, ay, tx, ty], width, tint, alpha);
			segment(stencil, [tx, ty, bx, by], width, tint, alpha);
			const [dax, day] = device(ax, ay);
			const [dtx, dty] = device(tx, ty);
			const [dbx, dby] = device(bx, by);
			const half = (width * view.ratio) / 2;
			const [ux, uy] = unit(dtx - dax, dty - day);
			const [vx, vy] = unit(dbx - dtx, dby - dty);
			const turn = ux * vy - uy * vx;
			if (Math.abs(turn) < 1e-6) return;
			const side = turn > 0 ? -1 : 1;
			const px = -uy * side;
			const py = ux * side;
			const qx = -vy * side;
			const qy = vx * side;
			const [mx, my] = unit(px + qx, py + qy);
			const reach = half / (mx * qx + my * qy);
			const tip = [dtx + mx * reach, dty + my * reach] as const;
			triangles(
				stencil,
				reach > half * 10
					? [
							[dtx, dty],
							[dtx + px * half, dty + py * half],
							[dtx + qx * half, dty + qy * half],
						]
					: [[dtx, dty], [dtx + px * half, dty + py * half], tip, [dtx, dty], tip, [dtx + qx * half, dty + qy * half]],
				tint,
				alpha,
			);
		},
		glyphs(points, count, color, alpha, outlined) {
			if (count <= 0) return;
			const fill = rgb(outlined ? outlined.surface : color);
			const shape = points[3] ?? 0;
			if (count === 1 && (shape === DOT || shape === SQUARE)) {
				const half = (points[2] ?? 0) * (shape === DOT ? DOT_SIDE / 2 : 0.85);
				const x = (points[0] ?? 0) - half;
				const y = (points[1] ?? 0) - half;
				analytic(RECT, [x, y, half * 2, half * 2], 0, fill, alpha);
			} else shapes(points, count, fillTemplate, 0, fill, alpha, nextStencil());
			if (outlined) shapes(points, count, strokeTemplate, outlined.width, rgb(color), alpha, nextStencil());
		},
		ring(x, y, radius, color, alpha, width) {
			shapes(new Float64Array([x, y, radius, CIRCLE]), 1, strokeTemplate, width, rgb(color), alpha, nextStencil());
		},
		selection(x, y, reach, color, alpha) {
			const tint = rgb(color);
			const stencil = nextStencil();
			const [cx, cy] = device(x, y);
			const radius = reach * view.zoom * view.ratio;
			const half = view.ratio / 2;
			const dash = 3 * view.ratio;
			const circumference = Math.PI * 2 * radius;
			for (let start = 0; start < circumference; start += dash * 2) {
				const end = Math.min(start + dash, circumference);
				const steps = Math.max(1, Math.ceil(((end - start) / radius) * 8));
				for (let step = 0; step < steps; step++) {
					const a0 = (start + ((end - start) * step) / steps) / radius;
					const a1 = (start + ((end - start) * (step + 1)) / steps) / radius;
					const outer0 = [cx + Math.cos(a0) * (radius + half), cy + Math.sin(a0) * (radius + half)] as const;
					const outer1 = [cx + Math.cos(a1) * (radius + half), cy + Math.sin(a1) * (radius + half)] as const;
					const inner0 = [cx + Math.cos(a0) * (radius - half), cy + Math.sin(a0) * (radius - half)] as const;
					const inner1 = [cx + Math.cos(a1) * (radius - half), cy + Math.sin(a1) * (radius - half)] as const;
					triangles(stencil, [outer0, outer1, inner1, outer0, inner1, inner0], tint, alpha);
				}
			}
			const ticks = nextStencil();
			const z = view.zoom;
			for (let tick = 0; tick < 4; tick++) {
				const angle = (Math.PI / 2) * tick + Math.PI / 4;
				const cos = Math.cos(angle);
				const sin = Math.sin(angle);
				segment(
					ticks,
					[x + cos * (reach + 2 / z), y + sin * (reach + 2 / z), x + cos * (reach + 6 / z), y + sin * (reach + 6 / z)],
					1,
					tint,
					alpha,
				);
			}
		},
		end() {
			const target_ = target();
			gl.bindFramebuffer(gl.FRAMEBUFFER, target_.frame);
			gl.viewport(0, 0, target_.width, target_.height);
			gl.clearColor(0, 0, 0, 0);
			gl.clearStencil(0);
			gl.stencilMask(0xff);
			gl.clear(gl.COLOR_BUFFER_BIT | gl.STENCIL_BUFFER_BIT);
			gl.enable(gl.BLEND);
			gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
			gl.bindVertexArray(vao);
			for (const [kind, each] of streams.entries()) {
				if (!each.count) continue;
				gl.bindBuffer(gl.ARRAY_BUFFER, buffers[kind] ?? null);
				gl.bufferData(gl.ARRAY_BUFFER, each.data.subarray(0, each.count * each.stride), gl.STREAM_DRAW);
			}
			for (const [kind, program] of programs.entries()) {
				const slot = uniforms[kind];
				activate(program);
				gl.uniform2f(slot?.pan ?? null, view.panX, view.panY);
				gl.uniform1f(slot?.zoom ?? null, view.zoom);
				gl.uniform1f(slot?.ratio ?? null, view.ratio);
				gl.uniform2f(slot?.size ?? null, target_.width, target_.height);
			}
			let applied = 0;
			for (const op of ops) {
				const kind = op.kind;
				const each = stream(kind);
				activate(programs[kind] ?? null);
				if (op.stencil) {
					if (op.stencil !== applied) {
						applied = op.stencil;
						if (op.stencil > 1 && (op.stencil - 1) % 255 === 0) gl.clear(gl.STENCIL_BUFFER_BIT);
					}
					gl.enable(gl.STENCIL_TEST);
					gl.stencilFunc(gl.NOTEQUAL, ((op.stencil - 1) % 255) + 1, 0xff);
					gl.stencilOp(gl.KEEP, gl.KEEP, gl.REPLACE);
				} else gl.disable(gl.STENCIL_TEST);
				for (let location = 0; location < 4; location++) gl.disableVertexAttribArray(location);
				if (kind !== RAW) {
					gl.bindBuffer(gl.ARRAY_BUFFER, kind === SHAPE ? (op.template?.buffer ?? null) : quad);
					gl.enableVertexAttribArray(0);
					gl.vertexAttribPointer(0, kind === SHAPE ? 4 : 2, gl.FLOAT, false, 0, 0);
					gl.vertexAttribDivisor(0, 0);
				}
				gl.bindBuffer(gl.ARRAY_BUFFER, buffers[kind] ?? null);
				let offset = 0;
				for (const [location, size] of layouts[kind] ?? []) {
					gl.enableVertexAttribArray(location);
					gl.vertexAttribPointer(
						location,
						size,
						gl.FLOAT,
						false,
						each.stride * 4,
						((kind === RAW ? 0 : op.first * each.stride) + offset) * 4,
					);
					gl.vertexAttribDivisor(location, kind === RAW ? 0 : 1);
					offset += size;
				}
				if (kind === RAW) gl.drawArrays(gl.TRIANGLES, op.first, op.count);
				else if (kind === SHAPE) gl.drawArraysInstanced(gl.TRIANGLES, 0, op.template?.vertices ?? 0, op.count);
				else gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, op.count);
			}
			gl.disable(gl.STENCIL_TEST);
			gl.bindVertexArray(null);
			gl.bindFramebuffer(gl.READ_FRAMEBUFFER, target_.frame);
			gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, target_.resolve);
			gl.blitFramebuffer(
				0,
				0,
				target_.width,
				target_.height,
				0,
				0,
				target_.width,
				target_.height,
				gl.COLOR_BUFFER_BIT,
				gl.NEAREST,
			);
			gl.bindFramebuffer(gl.FRAMEBUFFER, null);
			gl.viewport(0, 0, target_.width, target_.height);
			gl.disable(gl.BLEND);
			activate(copy);
			gl.activeTexture(gl.TEXTURE0);
			gl.bindTexture(gl.TEXTURE_2D, target_.texture);
			gl.drawArrays(gl.TRIANGLES, 0, 3);
		},
	};
}
