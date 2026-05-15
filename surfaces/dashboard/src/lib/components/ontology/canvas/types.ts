import type { OntologyEdgeKind, OntologyNodeKind } from "../ontology-data";

export type GraphNodeShape = "circle" | "rect" | "hex";

export interface GraphCanvasNode {
	id: string;
	kind: OntologyNodeKind;
	label: string;
	sublabel?: string;
	searchText?: string;
	parentId?: string;
	x: number;
	y: number;
	vx?: number;
	vy?: number;
	fx?: number | null;
	fy?: number | null;
	size: number;
	color: string;
	dimColor: string;
	shape?: GraphNodeShape;
	data: unknown;
}

export interface GraphCanvasEdge {
	id: string;
	sourceId: string;
	targetId: string;
	source: string | GraphCanvasNode;
	target: string | GraphCanvasNode;
	label: string;
	kind: OntologyEdgeKind;
	strength?: number;
	dashed?: boolean;
	visualOnly?: boolean;
}

export interface GraphRenderColors {
	selection: string;
	selectionGlow: string;
	text: string;
	textMuted: string;
	textDim: string;
	labelShadow: string;
	edges: Record<OntologyEdgeKind, { color: string; alpha: number; width: number }>;
	relatedGlow: Record<OntologyNodeKind, string>;
}

export interface GraphRenderState {
	selectedId: string | null;
	hoveredId: string | null;
	relatedIds: Set<string>;
	dimProgress: number;
}
