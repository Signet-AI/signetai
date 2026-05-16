import type { KnowledgeMapEdgeKind, KnowledgeMapNodeKind } from "../knowledge-map-data";

export type GraphNodeShape = "circle" | "rect" | "hex";

export interface GraphCanvasNode {
	id: string;
	kind: KnowledgeMapNodeKind;
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
	anchorDx?: number;
	anchorDy?: number;
	size: number;
	mass?: number;
	color: string;
	dimColor: string;
	sprite?: string;
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
	kind: KnowledgeMapEdgeKind;
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
	edges: Record<KnowledgeMapEdgeKind, { color: string; alpha: number; width: number }>;
	relatedGlow: Record<KnowledgeMapNodeKind, string>;
}

export interface GraphRenderState {
	selectedId: string | null;
	hoveredId: string | null;
	relatedIds: Set<string>;
	searchMatchIds: Set<string> | null;
	dimProgress: number;
}
