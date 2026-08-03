/**
 * Walrus-style 3D knowledge constellation — a faithful port of the locked
 * mockup's Three.js graph (web/marketing/public/redesign-home-mockup.html),
 * driven by real daemon data instead of the mockup's static NODES/EDGES.
 *
 * Framework-free: GraphView mounts it via `createGraphScene(container, data)`
 * and tears it down with `dispose()`.
 */
import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import { CSS2DRenderer, CSS2DObject } from "three/addons/renderers/CSS2DRenderer.js";
import { OBJLoader } from "three/addons/loaders/OBJLoader.js";
import sphereObj from "@/assets/bounding-sphere.obj?raw";

export type SceneNodeKind = "entity" | "aspect" | "attribute" | "source" | "memory";

export interface SceneNode {
	id: string;
	label: string;
	kind: SceneNodeKind;
	/** Cluster key — nodes of one entity fan around its shell direction. */
	cluster: string;
	/** 0..1 prominence — drives label eligibility for non-hubs. */
	weight: number;
	/** Inspector/hover metric line (e.g. "41 mentions"). */
	metric: string;
}

export interface SceneEdge {
	from: string;
	to: string;
}

export interface GraphSceneData {
	nodes: readonly SceneNode[];
	edges: readonly SceneEdge[];
}

export interface GraphSceneHandle {
	/** Orbit-tween to a node and highlight its neighborhood. */
	focusNode(id: string, drawerOpen?: boolean): void;
	resetView(): void;
	/** Node ids that can be focused (hubs). */
	focusable(): readonly string[];
	dispose(): void;
}

const COLORS: Record<SceneNodeKind, string> = {
	entity: "#ffffff",
	aspect: "#34d399",
	attribute: "#a78bfa",
	memory: "#a1a1aa",
	source: "#38bdf8",
};

const SPHERE_R = 260;
const seededRand = (s: number) => {
	const x = Math.sin(s * 9999 + 1) * 10000;
	return x - Math.floor(x);
};

interface LayoutNode extends SceneNode {
	pos: THREE.Vector3;
	/** Normalized position — precomputed once; the depth fade dots it per frame. */
	dir: THREE.Vector3;
}

/** Stable string hash — seeds deterministic per-parent fan orientations. */
const hashSeed = (s: string, salt: number) => {
	let h = salt | 0;
	for (let i = 0; i < s.length; i++) h = (h * 33 + s.charCodeAt(i)) | 0;
	return Math.abs(h);
};

export function createGraphScene(container: HTMLElement, data: GraphSceneData): GraphSceneHandle {
	const NODES: LayoutNode[] = [];
	const byId = new Map<string, LayoutNode>();

	// ── ForceAtlas2-style layout (one-shot, deterministic) ──
	// Hubs (entities + sources) relax over the dependency graph: repulsion
	// between every pair, LINEAR attraction along edges (quadratic
	// attraction is what collapses connected clusters into a blob), and a
	// whisper of gravity so isolates hover mid-sphere instead of piling
	// into the core. Runs once at scene build on flat typed arrays — no
	// continuous sim, no per-frame cost. Aspects/attributes then fan
	// around their OWN parent, so every entity reads as a local solar
	// system.
	const isHubKind = (k: SceneNodeKind) => k === "entity" || k === "source";
	const kindById = new Map(data.nodes.map((n) => [n.id, n.kind]));
	const hubs = data.nodes.filter((n) => isHubKind(n.kind));
	const hubIndex = new Map(hubs.map((n, i) => [n.id, i]));
	const parentOf = new Map<string, string>();
	const hubEdges: Array<readonly [number, number]> = [];
	for (const e of data.edges) {
		const fi = hubIndex.get(e.from);
		const ti = hubIndex.get(e.to);
		if (fi !== undefined && ti !== undefined) hubEdges.push([fi, ti]);
		else if (!isHubKind(kindById.get(e.to) ?? "aspect")) parentOf.set(e.to, e.from);
	}

	const hubCount = hubs.length;
	const deg = new Float32Array(hubCount);
	for (const [a, b] of hubEdges) { deg[a]++; deg[b]++; }
	const pos = new Float32Array(hubCount * 3);
	{
		// Fibonacci sphere start — deterministic, avoids degenerate symmetry.
		const golden = Math.PI * (3 - Math.sqrt(5));
		for (let i = 0; i < hubCount; i++) {
			const y = hubCount === 1 ? 0 : 1 - (i / (hubCount - 1)) * 2;
			const rXZ = Math.sqrt(Math.max(0, 1 - y * y));
			const theta = golden * i;
			pos[i * 3] = Math.cos(theta) * rXZ * 170;
			pos[i * 3 + 1] = y * 170;
			pos[i * 3 + 2] = Math.sin(theta) * rXZ * 170;
		}
	}
	const REPULSE = 135; // pairwise repulsion constant (≈ equilibrium² × attract)
	const ATTRACT = 0.15; // linear spring coefficient along dependency edges
	const GRAVITY = 0.02; // weak linear pull toward the origin
	const iterations = hubCount > 500 ? 60 : hubCount > 150 ? 100 : 150;
	const disp = new Float32Array(hubCount * 3);
	for (let iter = 0; iter < iterations; iter++) {
		disp.fill(0);
		// degree-weighted repulsion: popular nodes push harder, so
		// weakly-linked subgroups separate instead of stacking
		for (let a = 0; a < hubCount; a++) {
			const ax = pos[a * 3];
			const ay = pos[a * 3 + 1];
			const az = pos[a * 3 + 2];
			const ma = (deg[a] + 1) * REPULSE;
			for (let b = a + 1; b < hubCount; b++) {
				const dx = ax - pos[b * 3];
				const dy = ay - pos[b * 3 + 1];
				const dz = az - pos[b * 3 + 2];
				const d2 = Math.max(dx * dx + dy * dy + dz * dz, 9);
				const d = Math.sqrt(d2);
				const f = (ma * (deg[b] + 1)) / d / d;
				const fx = (dx / d) * f;
				const fy = (dy / d) * f;
				const fz = (dz / d) * f;
				disp[a * 3] += fx; disp[a * 3 + 1] += fy; disp[a * 3 + 2] += fz;
				disp[b * 3] -= fx; disp[b * 3 + 1] -= fy; disp[b * 3 + 2] -= fz;
			}
		}
		// linear attraction along edges — long links pull gently, so
		// connected regions hold together without collapsing
		for (const [a, b] of hubEdges) {
			const dx = pos[b * 3] - pos[a * 3];
			const dy = pos[b * 3 + 1] - pos[a * 3 + 1];
			const dz = pos[b * 3 + 2] - pos[a * 3 + 2];
			const d = Math.max(Math.sqrt(dx * dx + dy * dy + dz * dz), 0.01);
			const f = (ATTRACT * d) / d / (deg[a] + 1);
			const fx = dx * f;
			const fy = dy * f;
			const fz = dz * f;
			disp[a * 3] += fx; disp[a * 3 + 1] += fy; disp[a * 3 + 2] += fz;
			disp[b * 3] -= fx; disp[b * 3 + 1] -= fy; disp[b * 3 + 2] -= fz;
		}
		// weak gravity + cooling temperature
		const stepMax = 12 * (1 - iter / iterations) + 0.3;
		for (let i = 0; i < hubCount; i++) {
			const dx = disp[i * 3] - pos[i * 3] * GRAVITY;
			const dy = disp[i * 3 + 1] - pos[i * 3 + 1] * GRAVITY;
			const dz = disp[i * 3 + 2] - pos[i * 3 + 2] * GRAVITY;
			const len = Math.sqrt(dx * dx + dy * dy + dz * dz);
			if (len > 0.001) {
				const step = Math.min(len, stepMax);
				pos[i * 3] += (dx / len) * step;
				pos[i * 3 + 1] += (dy / len) * step;
				pos[i * 3 + 2] += (dz / len) * step;
			}
		}
	}
	{
		// normalize spread so the constellation fills the wireframe sphere
		let maxR = 1;
		for (let i = 0; i < hubCount; i++) {
			const r = Math.sqrt(pos[i * 3] ** 2 + pos[i * 3 + 1] ** 2 + pos[i * 3 + 2] ** 2);
			if (r > maxR) maxR = r;
		}
		const scale = 180 / maxR;
		for (let i = 0; i < hubCount * 3; i++) pos[i] *= scale;
	}

	// Golden-spiral fan around a center point (deterministic per sibling).
	const fanOffset = (j: number, count: number, radius: number, seed: number) => {
		const golden = Math.PI * (3 - Math.sqrt(5));
		const y = count === 1 ? 0 : 1 - (j / Math.max(1, count - 1)) * 2;
		const rXZ = Math.sqrt(Math.max(0, 1 - y * y));
		const theta = golden * j + seededRand(seed) * Math.PI * 2;
		return new THREE.Vector3(Math.cos(theta) * rXZ, y, Math.sin(theta) * rXZ).multiplyScalar(radius);
	};

	hubs.forEach((h, i) => {
		const v = new THREE.Vector3(pos[i * 3], pos[i * 3 + 1], pos[i * 3 + 2]);
		const layoutNode: LayoutNode = { ...h, pos: v, dir: v.clone().normalize() };
		NODES.push(layoutNode);
		byId.set(h.id, layoutNode);
	});

	// Children in two passes: aspects around their hub, then attributes
	// around their aspect. Orphans park on the outer hull.
	const aspectsByHub = new Map<string, SceneNode[]>();
	const attrsByAspect = new Map<string, SceneNode[]>();
	const orphans: SceneNode[] = [];
	for (const n of data.nodes) {
		if (isHubKind(n.kind)) continue;
		const parent = parentOf.get(n.id);
		if (!parent) { orphans.push(n); continue; }
		if (hubIndex.has(parent)) {
			const list = aspectsByHub.get(parent) ?? [];
			list.push(n);
			aspectsByHub.set(parent, list);
		} else {
			const list = attrsByAspect.get(parent) ?? [];
			list.push(n);
			attrsByAspect.set(parent, list);
		}
	}
	aspectsByHub.forEach((aspects, hubId) => {
		const hub = byId.get(hubId)!;
		const radius = 15 + aspects.length * 2.2;
		aspects.forEach((asp, j) => {
			const v = hub.pos.clone().add(fanOffset(j, aspects.length, radius, hashSeed(hubId, j + 1)));
			const layoutNode: LayoutNode = { ...asp, pos: v, dir: v.clone().normalize() };
			NODES.push(layoutNode);
			byId.set(asp.id, layoutNode);
		});
	});
	attrsByAspect.forEach((attrs, aspectId) => {
		const aspect = byId.get(aspectId);
		if (!aspect) { orphans.push(...attrs); return; }
		const radius = 8 + attrs.length * 1.4;
		attrs.forEach((attr, j) => {
			const v = aspect.pos.clone().add(fanOffset(j, attrs.length, radius, hashSeed(aspectId, j + 7)));
			const layoutNode: LayoutNode = { ...attr, pos: v, dir: v.clone().normalize() };
			NODES.push(layoutNode);
			byId.set(attr.id, layoutNode);
		});
	});
	orphans.forEach((n, j) => {
		const v = fanOffset(j, orphans.length, 225, hashSeed(n.id, 31));
		const layoutNode: LayoutNode = { ...n, pos: v, dir: v.clone().normalize() };
		NODES.push(layoutNode);
		byId.set(n.id, layoutNode);
	});

	const EDGES = data.edges.filter((e) => byId.has(e.from) && byId.has(e.to));

	// ── Three.js setup ──
	const canvas = document.createElement("canvas");
	canvas.style.cssText = "width:100%;height:100%;display:block;cursor:grab";
	const labelContainer = document.createElement("div");
	labelContainer.style.cssText = "position:absolute;inset:0;pointer-events:none;z-index:1";
	container.appendChild(canvas);
	container.appendChild(labelContainer);

	const scene = new THREE.Scene();
	scene.fog = new THREE.FogExp2(0x050505, 0.0018);
	const w = container.clientWidth || 800;
	const h = container.clientHeight || 500;
	const camera = new THREE.PerspectiveCamera(55, w / h, 0.1, 3000);
	camera.position.set(0, 80, 520);

	const renderer = new THREE.WebGLRenderer({ canvas, alpha: true, antialias: true });
	renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
	renderer.setSize(w, h, false);

	const labelRenderer = new CSS2DRenderer();
	labelRenderer.setSize(w, h);
	labelRenderer.domElement.style.position = "absolute";
	labelRenderer.domElement.style.top = "0";
	labelRenderer.domElement.style.pointerEvents = "none";
	labelContainer.appendChild(labelRenderer.domElement);

	const controls = new OrbitControls(camera, renderer.domElement);
	controls.enableDamping = true;
	controls.dampingFactor = 0.06;
	controls.rotateSpeed = 0.5;
	controls.zoomSpeed = 0.8;
	controls.autoRotate = true;
	controls.autoRotateSpeed = 0.4;
	controls.minDistance = 100;
	controls.maxDistance = 1200;

	// ── wireframe bounding sphere (Walrus anchor) ──
	const sphereMat = new THREE.LineBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.28, depthWrite: false });
	const sphereModel = new OBJLoader().parse(sphereObj);
	sphereModel.traverse((child) => {
		if ((child as THREE.LineSegments).isLineSegments) {
			(child as THREE.LineSegments).material = sphereMat;
		}
	});
	sphereModel.scale.setScalar(SPHERE_R);
	scene.add(sphereModel);

	// ── node shape textures: crosshair (source), diamond (entity), square (leaf) ──
	const makeShapeTexture = (drawFn: (ctx: CanvasRenderingContext2D) => void) => {
		const c = document.createElement("canvas");
		c.width = c.height = 16;
		const ctx = c.getContext("2d")!;
		ctx.strokeStyle = "#fff";
		ctx.fillStyle = "#fff";
		drawFn(ctx);
		return new THREE.CanvasTexture(c);
	};
	const crossTex = makeShapeTexture((ctx) => {
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(8, 2); ctx.lineTo(8, 14);
		ctx.moveTo(2, 8); ctx.lineTo(14, 8);
		ctx.stroke();
	});
	const diamondTex = makeShapeTexture((ctx) => {
		ctx.lineWidth = 1.5;
		ctx.beginPath();
		ctx.moveTo(8, 2); ctx.lineTo(14, 8); ctx.lineTo(8, 14); ctx.lineTo(2, 8);
		ctx.closePath(); ctx.stroke();
	});
	const squareTex = makeShapeTexture((ctx) => {
		ctx.fillRect(6, 6, 4, 4);
	});

	// ── nodes rendered as multiple Points layers by kind ──
	const KIND_TEX: Record<SceneNodeKind, THREE.CanvasTexture> = {
		entity: diamondTex, source: crossTex, aspect: squareTex, attribute: squareTex, memory: squareTex,
	};
	const KIND_SIZE: Record<SceneNodeKind, number> = { entity: 24, source: 27, aspect: 12, attribute: 9, memory: 9 };
	const baseColors: THREE.Color[] = [];
	interface NodeLayer { pts: THREE.Points; geo: THREE.BufferGeometry; colArr: Float32Array; origIndices: number[] }
	const nodeLayers: Partial<Record<SceneNodeKind, NodeLayer>> = {};
	(["entity", "source", "aspect", "attribute", "memory"] as const).forEach((kind) => {
		const kindNodes = NODES.map((n, i) => ({ n, i })).filter(({ n }) => n.kind === kind);
		if (kindNodes.length === 0) return;
		const geo = new THREE.BufferGeometry();
		const pos = new Float32Array(kindNodes.length * 3);
		const col = new Float32Array(kindNodes.length * 3);
		kindNodes.forEach(({ n, i: origIdx }, j) => {
			pos[j * 3] = n.pos.x; pos[j * 3 + 1] = n.pos.y; pos[j * 3 + 2] = n.pos.z;
			const c = new THREE.Color(COLORS[kind]);
			col[j * 3] = c.r; col[j * 3 + 1] = c.g; col[j * 3 + 2] = c.b;
			if (baseColors[origIdx] === undefined) baseColors[origIdx] = c.clone();
		});
		geo.setAttribute("position", new THREE.BufferAttribute(pos, 3));
		geo.setAttribute("color", new THREE.BufferAttribute(col, 3));
		const mat = new THREE.PointsMaterial({
			size: KIND_SIZE[kind], map: KIND_TEX[kind], vertexColors: true,
			transparent: true, depthWrite: false, sizeAttenuation: true,
		});
		const pts = new THREE.Points(geo, mat);
		pts.userData = { kind };
		scene.add(pts);
		nodeLayers[kind] = { pts, geo, colArr: col, origIndices: kindNodes.map(({ i }) => i) };
	});
	NODES.forEach((n, i) => { if (!baseColors[i]) baseColors[i] = new THREE.Color(COLORS[n.kind]); });

	// ── CSS2D labels (hubs + high-weight aspects) with leader lines ──
	interface LabelEntry { obj: CSS2DObject; div: HTMLDivElement; pos: THREE.Vector3; dir: THREE.Vector3; leader: THREE.Line }
	const labelObjs: Record<string, LabelEntry> = {};
	// Adaptive label budget: the 40 most prominent hubs earn labels (plus
	// all sources and high-weight aspects) so dense scenes stay readable.
	const hubLabelThreshold = (() => {
		const weights = NODES.filter((n) => n.kind === "entity").map((n) => n.weight).sort((a, b) => b - a);
		return weights.length > 40 ? Math.max(0.35, weights[40]) : 0.35;
	})();
	NODES.forEach((n) => {
		// Sources always earn labels; entity hubs only when prominent (sqrt
		// mention weight), so dense scenes don't drown in text. Of the leaves
		// only high-weight aspects.
		const labelable = n.kind === "source" || (n.kind === "entity" && n.weight >= hubLabelThreshold);
		if (!labelable && (n.kind !== "aspect" || n.weight < 0.75)) return;
		const div = document.createElement("div");
		div.textContent = n.label;
		div.style.cssText = "font-family:var(--font-mono);font-size:10px;color:#f4f4f5;" +
			"background:rgba(9,9,11,0.9);padding:1px 4px;border-radius:3px;border:1px solid oklch(1 0 0 / 0.08);" +
			"white-space:nowrap;opacity:0;transition:opacity .4s;letter-spacing:0.02em;font-weight:500";
		const obj = new CSS2DObject(div);
		obj.position.set(n.pos.x + 7, n.pos.y + 10, n.pos.z + 7);
		scene.add(obj);
		const lOffset = 10;
		const leaderGeo = new THREE.BufferGeometry();
		leaderGeo.setAttribute("position", new THREE.Float32BufferAttribute([
			n.pos.x, n.pos.y, n.pos.z,
			n.pos.x + lOffset * 0.7, n.pos.y + lOffset, n.pos.z + lOffset * 0.7,
		], 3));
		const leaderMat = new THREE.LineBasicMaterial({ color: 0x71717a, transparent: true, opacity: 0.5, depthWrite: false });
		const leader = new THREE.Line(leaderGeo, leaderMat);
		scene.add(leader);
		labelObjs[n.id] = { obj, div, pos: n.pos.clone(), dir: n.dir, leader };
	});

	// ── razor-thin Bezier edges (0.1 opacity for moiré density) ──
	const edgeMeshes: THREE.Line[] = [];
	EDGES.forEach(({ from, to }) => {
		const a = byId.get(from)!;
		const b = byId.get(to)!;
		const mid = a.pos.clone().add(b.pos).multiplyScalar(0.5);
		if (mid.length() > 0) mid.multiplyScalar(1.25);
		const curve = new THREE.QuadraticBezierCurve3(a.pos, mid, b.pos);
		const geo = new THREE.BufferGeometry().setFromPoints(curve.getPoints(8));
		const mat = new THREE.LineBasicMaterial({ color: 0x00f2ff, transparent: true, opacity: 0.13, depthWrite: false });
		const line = new THREE.Line(geo, mat);
		scene.add(line);
		edgeMeshes.push(line);
	});

	// ── ground dot grid floor ──
	const floorY = -SPHERE_R - 30;
	const gridDivs = 20;
	const gridStep = SPHERE_R * 0.15;
	const gridPos: number[] = [];
	for (let gx = -gridDivs; gx <= gridDivs; gx++) {
		for (let gz = -gridDivs; gz <= gridDivs; gz++) {
			if (Math.sqrt(gx * gx + gz * gz) > gridDivs * 0.8) continue;
			gridPos.push(gx * gridStep, floorY, gz * gridStep);
		}
	}
	const gridGeo = new THREE.BufferGeometry();
	gridGeo.setAttribute("position", new THREE.Float32BufferAttribute(gridPos, 3));
	scene.add(new THREE.Points(gridGeo, new THREE.PointsMaterial({ size: 1.5, color: 0x1a3a30, transparent: true, opacity: 0.3, sizeAttenuation: true, depthWrite: false })));

	// ── dashed drop lines from hubs to floor ──
	const dropPositions: number[] = [];
	NODES.forEach((n) => {
		if (n.kind !== "entity" && n.kind !== "source") return;
		dropPositions.push(n.pos.x, n.pos.y, n.pos.z, n.pos.x, floorY, n.pos.z);
	});
	if (dropPositions.length > 0) {
		const dropGeo = new THREE.BufferGeometry();
		dropGeo.setAttribute("position", new THREE.Float32BufferAttribute(dropPositions, 3));
		const dropLines = new THREE.LineSegments(dropGeo, new THREE.LineDashedMaterial({ color: 0x1a4a3a, transparent: true, opacity: 0.15, dashSize: 3, gapSize: 6, depthWrite: false }));
		dropLines.computeLineDistances();
		scene.add(dropLines);
	}

	// ── background micro-pixel dust ──
	const DUST_COUNT = 2200;
	const dustPos = new Float32Array(DUST_COUNT * 3);
	for (let d = 0; d < DUST_COUNT; d++) {
		const r = (0.3 + Math.random() * 0.7) * SPHERE_R;
		const th = Math.random() * Math.PI * 2;
		const ph = Math.acos(2 * Math.random() - 1);
		dustPos[d * 3] = r * Math.sin(ph) * Math.cos(th);
		dustPos[d * 3 + 1] = r * Math.cos(ph);
		dustPos[d * 3 + 2] = r * Math.sin(ph) * Math.sin(th);
	}
	const dustGeo = new THREE.BufferGeometry();
	dustGeo.setAttribute("position", new THREE.BufferAttribute(dustPos, 3));
	scene.add(new THREE.Points(dustGeo, new THREE.PointsMaterial({ size: 1.5, color: 0x52525b, transparent: true, opacity: 0.4, sizeAttenuation: true, depthWrite: false })));

	// ── origin reticle crosshair ⊕ ──
	const reticleR = 8;
	const reticleGeo = new THREE.BufferGeometry();
	reticleGeo.setAttribute("position", new THREE.Float32BufferAttribute([
		-reticleR, 0, 0, reticleR, 0, 0,
		0, -reticleR, 0, 0, reticleR, 0,
		0, 0, -reticleR, 0, 0, reticleR,
	], 3));
	scene.add(new THREE.LineSegments(reticleGeo, new THREE.LineBasicMaterial({ color: 0x10b981, transparent: true, opacity: 0.4, depthWrite: false })));

	// ── node targeting bracket + readout (CAD-style hover reticle) ──
	const targetBracket = new THREE.Group();
	targetBracket.visible = false;
	const bracketR = 14;
	const bracketCorner = 5;
	const cornerPts: number[] = [];
	([[-1, -1], [1, -1], [-1, 1], [1, 1]] as const).forEach(([sx, sy]) => {
		const x = sx * bracketR;
		const y = sy * bracketR;
		cornerPts.push(x, y, 0, x - sx * bracketCorner, y, 0);
		cornerPts.push(x, y, 0, x, y - sy * bracketCorner, 0);
	});
	const bracketGeo = new THREE.BufferGeometry();
	bracketGeo.setAttribute("position", new THREE.Float32BufferAttribute(cornerPts, 3));
	targetBracket.add(new THREE.LineSegments(bracketGeo, new THREE.LineBasicMaterial({ color: 0x38bdf8, transparent: true, opacity: 0.8, depthWrite: false })));
	scene.add(targetBracket);

	const targetReadout = document.createElement("div");
	targetReadout.style.cssText = "position:absolute;display:none;font-family:var(--font-mono);font-size:9px;" +
		"color:#f4f4f5;background:rgba(9,9,11,0.92);padding:5px 8px;border-radius:4px;border:1px solid oklch(1 0 0 / 0.1);" +
		"pointer-events:none;line-height:1.5;z-index:10;white-space:nowrap";
	labelContainer.appendChild(targetReadout);

	const raycaster = new THREE.Raycaster();
	raycaster.params.Points = { threshold: 8 };
	const mouseNDC = new THREE.Vector2(-2, -2);
	const onPointerMove = (ev: PointerEvent) => {
		const rect = renderer.domElement.getBoundingClientRect();
		mouseNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1;
		mouseNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1;
	};
	renderer.domElement.addEventListener("pointermove", onPointerMove);

	// ── turntable camera rig ──
	interface CamTween {
		t0: number; dur: number;
		fromTheta: number; fromPhi: number; dTheta: number; dPhi: number;
		fromRadius: number; toRadius: number;
		fromTarget: THREE.Vector3; toTarget: THREE.Vector3;
	}
	let camTween: CamTween | null = null;
	const dirToAngles = (dir: THREE.Vector3) => {
		const d = dir.clone().normalize();
		return { theta: Math.atan2(d.x, d.z), phi: Math.acos(Math.max(-1, Math.min(1, d.y))) };
	};
	const anglesToDir = (theta: number, phi: number) => new THREE.Vector3(
		Math.sin(phi) * Math.sin(theta), Math.cos(phi), Math.sin(phi) * Math.cos(theta),
	);
	const ORIGIN = new THREE.Vector3(0, 0, 0);
	const startTween = (toTheta: number, toPhi: number, toRadius: number, toTarget: THREE.Vector3, dur = 1680) => {
		const a = dirToAngles(camera.position.clone().sub(ORIGIN));
		let dTheta = toTheta - a.theta;
		while (dTheta > Math.PI) dTheta -= 2 * Math.PI;
		while (dTheta < -Math.PI) dTheta += 2 * Math.PI;
		let dPhi = toPhi - a.phi;
		while (dPhi > Math.PI) dPhi -= 2 * Math.PI;
		while (dPhi < -Math.PI) dPhi += 2 * Math.PI;
		camTween = {
			t0: performance.now(), dur,
			fromTheta: a.theta, fromPhi: a.phi, dTheta, dPhi,
			fromRadius: camera.position.clone().sub(ORIGIN).length(), toRadius,
			fromTarget: controls.target.clone(), toTarget: toTarget.clone(),
		};
	};

	// ── focus highlight state — smoothly blended per-frame, in sync with ──
	// the camera tween (same quintic ease + duration), so the emphasis
	// lands exactly as the camera arrives.
	let highlightSet: Set<string> | null = null;
	let highlightMix = 0;
	let highlightTween: { t0: number; from: number; to: number; dur: number } | null = null;
	const HIGHLIGHT_DIM = 0.06;
	const HIGHLIGHT_SAT = 0.12; // residual saturation for non-members
	const setHighlight = (ids: Set<string> | null) => {
		highlightSet = ids;
		highlightTween = { t0: performance.now(), from: highlightMix, to: ids ? 1 : 0, dur: 1680 };
	};
	const neighbors = (id: string) => {
		const set = new Set([id]);
		EDGES.forEach(({ from, to }) => { if (from === id) set.add(to); if (to === id) set.add(from); });
		return set;
	};
	const focusNode = (id: string, drawerOpen = false) => {
		const n = byId.get(id);
		if (!n) return;
		controls.autoRotate = false;
		const targetDir = n.pos.clone().normalize();
		const a = dirToAngles(targetDir);
		const target = n.pos.clone();
		if (drawerOpen) {
			const right = anglesToDir(a.theta + Math.PI / 2, Math.PI / 2);
			target.add(right.multiplyScalar(45));
		}
		startTween(a.theta, a.phi, 240, target);
		setHighlight(neighbors(id));
	};
	const resetView = () => {
		controls.autoRotate = true;
		const homeDir = new THREE.Vector3(0, 0.15, 1).normalize();
		const a = dirToAngles(homeDir);
		startTween(a.theta, a.phi, 520, ORIGIN.clone());
		setHighlight(null);
	};

	// ── render loop ──
	let raf = 0;
	let disposed = false;
	const animate = () => {
		if (disposed) return;
		raf = requestAnimationFrame(animate);
		if (camTween) {
			const elapsed = performance.now() - camTween.t0;
			const t = Math.min(1, elapsed / camTween.dur);
			const orbitEase = t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
			const theta = camTween.fromTheta + camTween.dTheta * orbitEase;
			const phi = camTween.fromPhi + camTween.dPhi * orbitEase;
			let radius: number;
			if (t < 0.4) {
				radius = camTween.fromRadius;
			} else {
				const zoomT = (t - 0.4) / 0.6;
				const zoomEase = zoomT * zoomT * zoomT * (zoomT * (6 * zoomT - 15) + 10);
				radius = camTween.fromRadius + (camTween.toRadius - camTween.fromRadius) * zoomEase;
			}
			camera.position.copy(ORIGIN).add(anglesToDir(theta, phi).multiplyScalar(radius));
			controls.target.lerpVectors(camTween.fromTarget, camTween.toTarget, orbitEase);
			if (t >= 1) camTween = null;
		}
		controls.update();

		// Advance the highlight blend on the camera's clock
		if (highlightTween) {
			const t = Math.min(1, (performance.now() - highlightTween.t0) / highlightTween.dur);
			const e = t < 0.5 ? 16 * t * t * t * t * t : 1 - Math.pow(-2 * t + 2, 5) / 2;
			highlightMix = highlightTween.from + (highlightTween.to - highlightTween.from) * e;
			if (t >= 1) highlightTween = null;
		}

		// Spherical depth fade + focus emphasis: front hemisphere full, back
		// dimmed; while focused, cluster members hold full saturated color and
		// everything else falls to a dim, desaturated floor.
		const camDir = camera.position.clone().sub(controls.target).normalize();
		Object.entries(nodeLayers).forEach(([kind, layer]) => {
			if (!layer) return;
			const isHub = kind === "entity" || kind === "source";
			layer.origIndices.forEach((origIdx, j) => {
				const dot = NODES[origIdx].dir.dot(camDir);
				const base = baseColors[origIdx];
				const depthAlpha = dot > 0 ? 1.0 : isHub ? 0.2 : 0.08;
				let bright = depthAlpha;
				let sat = 1;
				if (highlightMix > 0 && highlightSet) {
					if (highlightSet.has(NODES[origIdx].id)) {
						bright = depthAlpha + (1 - depthAlpha) * highlightMix;
					} else {
						bright = depthAlpha + (Math.min(depthAlpha, HIGHLIGHT_DIM) - depthAlpha) * highlightMix;
						sat = 1 - (1 - HIGHLIGHT_SAT) * highlightMix;
					}
				}
				let r = base.r;
				let g = base.g;
				let b = base.b;
				if (sat < 1) {
					const gray = base.r * 0.299 + base.g * 0.587 + base.b * 0.114;
					r = gray + (r - gray) * sat;
					g = gray + (g - gray) * sat;
					b = gray + (b - gray) * sat;
				}
				layer.colArr[j * 3] = r * bright;
				layer.colArr[j * 3 + 1] = g * bright;
				layer.colArr[j * 3 + 2] = b * bright;
			});
			layer.geo.getAttribute("color").needsUpdate = true;
		});
		if (highlightMix > 0) {
			edgeMeshes.forEach((e) => { (e.material as THREE.LineBasicMaterial).opacity = 0.13 - 0.1 * highlightMix; });
		}
		Object.values(labelObjs).forEach((lb) => {
			const dot = lb.dir.dot(camDir);
			lb.div.style.opacity = dot > 0.3 ? String(Math.min(1, (dot - 0.3) * 1.5)) : "0";
			lb.leader && ((lb.leader.material as THREE.LineBasicMaterial).opacity = dot > 0.3 ? 0.4 : 0);
		});

		// Hover raycast → targeting bracket + CAD readout (hubs only)
		raycaster.setFromCamera(mouseNDC, camera);
		const hubPoints = (["entity", "source"] as const)
			.map((k) => nodeLayers[k]?.pts)
			.filter((p): p is THREE.Points => Boolean(p));
		const intersects = hubPoints.length > 0 ? raycaster.intersectObjects(hubPoints, false) : [];
		if (intersects.length > 0) {
			const layer = nodeLayers[intersects[0].object.userData.kind as SceneNodeKind]!;
			const n = NODES[layer.origIndices[intersects[0].index!]];
			targetBracket.visible = true;
			targetBracket.position.copy(n.pos);
			const sp = n.pos.clone().project(camera);
			const sx = (sp.x * 0.5 + 0.5) * renderer.domElement.clientWidth;
			const sy = (-sp.y * 0.5 + 0.5) * renderer.domElement.clientHeight;
			const edgeCount = EDGES.filter((e) => e.from === n.id || e.to === n.id).length;
			targetReadout.style.display = "block";
			targetReadout.style.left = `${sx + 20}px`;
			targetReadout.style.top = `${sy - 30}px`;
			targetReadout.innerHTML =
				`node: <span style="color:#38bdf8">${n.label}</span><br>` +
				`edges: ${edgeCount} · ${n.metric}<br>` +
				`xyz: ${n.pos.x.toFixed(1)}, ${n.pos.y.toFixed(1)}, ${n.pos.z.toFixed(1)}`;
		} else {
			targetBracket.visible = false;
			targetReadout.style.display = "none";
		}

		renderer.render(scene, camera);
		labelRenderer.render(scene, camera);
	};
	animate();

	// ── resize ──
	const ro = new ResizeObserver(() => {
		const nw = container.clientWidth;
		const nh = container.clientHeight;
		if (nw === 0 || nh === 0) return;
		camera.aspect = nw / nh;
		camera.updateProjectionMatrix();
		renderer.setSize(nw, nh, false);
		labelRenderer.setSize(nw, nh);
	});
	ro.observe(container);
	const stopAutoRotate = () => { controls.autoRotate = false; };
	controls.addEventListener("start", stopAutoRotate);

	return {
		focusNode,
		resetView,
		focusable: () => NODES.filter((n) => n.kind === "entity" || n.kind === "source").map((n) => n.id),
		dispose: () => {
			disposed = true;
			cancelAnimationFrame(raf);
			ro.disconnect();
			controls.removeEventListener("start", stopAutoRotate);
			controls.dispose();
			renderer.domElement.removeEventListener("pointermove", onPointerMove);
			scene.traverse((obj) => {
				const mesh = obj as THREE.Mesh;
				if (mesh.geometry) mesh.geometry.dispose();
				const mat = (mesh as unknown as { material?: THREE.Material | THREE.Material[] }).material;
				if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
				else if (mat) mat.dispose();
			});
			[crossTex, diamondTex, squareTex].forEach((t) => t.dispose());
			renderer.dispose();
			container.replaceChildren();
		},
	};
}
