export interface KernelLink {
	readonly source: number;
	readonly target: number;
	readonly bias: number;
	readonly strength: number;
	readonly distance: number;
}

export interface KernelSettings {
	readonly theta2: number;
	readonly distanceMin2: number;
	readonly distanceMax2: number;
	readonly collideStrength: number;
	readonly centerX: number;
	readonly centerY: number;
	readonly centerStrength: number;
}

export interface KernelBodies {
	readonly x: number;
	readonly y: number;
	vx: number;
	vy: number;
}

export interface KernelLayout {
	apply(bodies: readonly KernelBodies[], alpha: number): void;
	dispose(): void;
}

export interface LayoutKernel {
	create(
		charge: readonly number[],
		radius: readonly number[],
		links: readonly KernelLink[],
		settings: KernelSettings,
	): KernelLayout;
}

interface Exports {
	readonly memory: WebAssembly.Memory;
	layout_create(nodes: number, links: number): number;
	layout_buffer(handle: number, field: number): number;
	layout_configure(
		handle: number,
		theta2: number,
		distanceMin2: number,
		distanceMax2: number,
		collideStrength: number,
		centerX: number,
		centerY: number,
		centerStrength: number,
	): number;
	layout_apply(handle: number, alpha: number): number;
	layout_drop(handle: number): void;
}

const FIELD = {
	x: 0,
	y: 1,
	vx: 2,
	vy: 3,
	charge: 4,
	radius: 5,
	source: 6,
	target: 7,
	bias: 8,
	strength: 9,
	distance: 10,
} as const;

export async function loadLayoutKernel(bytes: BufferSource): Promise<LayoutKernel> {
	const instance = await WebAssembly.instantiate(await WebAssembly.compile(bytes), {});
	const wasm = instance.exports as unknown as Exports;
	return {
		create(charge, radius, links, settings) {
			const nodes = charge.length;
			if (radius.length !== nodes) throw new Error("Layout kernel needs one radius per node");
			for (const link of links)
				if (!(link.source >= 0 && link.source < nodes && link.target >= 0 && link.target < nodes))
					throw new Error("Layout kernel link points outside the node list");
			let handle: number | undefined = wasm.layout_create(nodes, links.length);
			const floats = (field: number, length: number) =>
				new Float64Array(wasm.memory.buffer, wasm.layout_buffer(handle ?? -1, field), length);
			const ints = (field: number, length: number) =>
				new Uint32Array(wasm.memory.buffer, wasm.layout_buffer(handle ?? -1, field), length);
			floats(FIELD.charge, nodes).set(charge);
			floats(FIELD.radius, nodes).set(radius);
			const sources = ints(FIELD.source, links.length);
			const targets = ints(FIELD.target, links.length);
			const bias = floats(FIELD.bias, links.length);
			const strength = floats(FIELD.strength, links.length);
			const distance = floats(FIELD.distance, links.length);
			for (const [index, link] of links.entries()) {
				sources[index] = link.source;
				targets[index] = link.target;
				bias[index] = link.bias;
				strength[index] = link.strength;
				distance[index] = link.distance;
			}
			const valid = wasm.layout_configure(
				handle,
				settings.theta2,
				settings.distanceMin2,
				settings.distanceMax2,
				settings.collideStrength,
				settings.centerX,
				settings.centerY,
				settings.centerStrength,
			);
			if (valid !== 1) {
				wasm.layout_drop(handle);
				throw new Error("Layout kernel rejected its configuration");
			}
			return {
				apply(bodies, alpha) {
					if (handle === undefined) throw new Error("Layout kernel layout was disposed");
					if (bodies.length !== nodes) throw new Error("Layout kernel node count changed");
					const x = floats(FIELD.x, nodes);
					const y = floats(FIELD.y, nodes);
					const vx = floats(FIELD.vx, nodes);
					const vy = floats(FIELD.vy, nodes);
					for (let index = 0; index < nodes; index++) {
						const body = bodies[index] as KernelBodies;
						x[index] = body.x;
						y[index] = body.y;
						vx[index] = body.vx;
						vy[index] = body.vy;
					}
					if (wasm.layout_apply(handle, alpha) !== 1) throw new Error("Layout kernel step failed");
					const nextVx = floats(FIELD.vx, nodes);
					const nextVy = floats(FIELD.vy, nodes);
					for (let index = 0; index < nodes; index++) {
						const body = bodies[index] as KernelBodies;
						body.vx = nextVx[index] ?? 0;
						body.vy = nextVy[index] ?? 0;
					}
				},
				dispose() {
					if (handle === undefined) return;
					wasm.layout_drop(handle);
					handle = undefined;
				},
			};
		},
	};
}
