import { MemoryChat } from "@/components/memory-chat";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle, DialogDescription } from "@/components/ui/dialog";
import { Skeleton } from "@/components/ui/skeleton";
import { PanelRightOpenIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import type { GraphSceneData, GraphSceneHandle, SceneEdge, SceneEdgeKind, SceneNode } from "@/lib/graph-scene";
import { capGraphSceneData, graphEvidenceRefs, MAX_VISIBLE_CONSTELLATION_NODES } from "@/lib/constellation-display";

const ENTITY_LIMIT = 150;

const LEGEND = [
	{ color: "#a1a1aa", label: "entity" },
	{ color: "#34d399", label: "aspect" },
	{ color: "#60a5fa", label: "group" },
	{ color: "#f59e0b", label: "claim slot" },
	{ color: "#a78bfa", label: "attribute" },
	{ color: "#fbbf24", label: "claim" },
	{ color: "#fb7185", label: "constraint" },
	{ color: "#f472b6", label: "assertion" },
	{ color: "#22d3ee", label: "evidence" },
	{ color: "#38bdf8", label: "source" },
] as const;

interface EntityDetail {
	id: string;
	name: string;
	mentions: number;
	aspectCount: number;
	attributeCount: number;
	edgeCount: number;
	topAspects: { name: string; weight: number }[];
	citations: { id: string; text: string; meta: string }[];
}

function shorten(value: string, maxLength: number): string {
	const normalized = value.replace(/\s+/g, " ").trim();
	return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}…` : normalized;
}

function humanize(value: string): string {
	return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function percent(value: number): string {
	return `${Math.round(Math.min(1, Math.max(0, value)) * 100)}%`;
}

function provenanceLabel(
	sourceKind: string | null,
	sourceId: string | null,
	sourcePath: string | null,
	sourceRoot: string | null,
	memoryId: string | null,
): string | null {
	const path = sourcePath?.split(/[\\/]/).filter(Boolean).slice(-2).join("/");
	const root = sourceRoot?.split(/[\\/]/).filter(Boolean).pop();
	const kind = sourceKind ? humanize(sourceKind.replace(/^source_/, "")) : null;
	if (kind && path && root) return shorten(`${kind} · ${root}/${path}`, 52);
	if (kind && path) return shorten(`${kind} · ${path}`, 52);
	if (path) return shorten(path, 52);
	if (kind) return shorten(kind, 52);
	if (memoryId) return `Memory · ${shorten(memoryId, 30)}`;
	if (sourceId) return `Source · ${shorten(sourceId, 30)}`;
	return null;
}
export function GraphView() {
	const entityLimit = ENTITY_LIMIT;
	const graphQuery = useAsync(() => api.getKnowledgeConstellation(entityLimit, Math.min(2000, entityLimit * 4)), {
		key: `constellation:${entityLimit}:${Math.min(2000, entityLimit * 4)}`,
		intervalMs: 30_000,
		deps: [entityLimit],
	});
	const sources = useAsync(() => api.getSources(), { key: "sources", intervalMs: 30_000 }).data?.sources;
	const [inspected, setInspected] = useState<SceneNode | null>(null);
	const selectionRef = useRef<(node: SceneNode) => void>(() => {});
	const [legendOpen, setLegendOpen] = useState(false);
	const [detail, setDetail] = useState<EntityDetail | null>(null);
	const [responded, setResponded] = useState(false);
	const [chatOpen, setChatOpen] = useState(false);
	const [sceneFailed, setSceneFailed] = useState(false);
	const stageRef = useRef<HTMLDivElement>(null);
	const sceneRef = useRef<GraphSceneHandle | null>(null);
	const builtSigRef = useRef<number | null>(null);

	const sceneData = useMemo<GraphSceneData>(() => {
		const nodes: SceneNode[] = [];
		const edges: SceneEdge[] = [];
		const nodeIds = new Set<string>();
		const seen = new Set<string>();
		const addNode = (node: SceneNode) => {
			if (nodeIds.has(node.id)) return;
			nodeIds.add(node.id);
			nodes.push(node);
		};
		const addEdge = (from: string, to: string, kind: SceneEdgeKind, label?: string, strength?: number) => {
			const key = `${kind}:${from}:${to}:${label ?? ""}`;
			if (seen.has(key)) return;
			seen.add(key);
			edges.push({ from, to, kind, label, strength });
		};
		const entities = graphQuery.data?.entities ?? [];
		const maxMentions = Math.max(1, ...entities.map((e) => e.mentions));
		const attributeNodeIds = new Map<string, string>();
		const originNodeIds = new Map<string, string>();
		const ensureOrigin = (params: {
			sourceKind: string | null;
			sourceId: string | null;
			sourcePath: string | null;
			sourceRoot: string | null;
			memoryId: string | null;
			cluster: string;
		}): string | null => {
			const source = provenanceLabel(
				params.sourceKind,
				params.sourceId,
				params.sourcePath,
				params.sourceRoot,
				params.memoryId,
			);
			if (!source) return null;
			const sourceKey = `${params.sourceKind ?? ""}:${params.sourceId ?? ""}:${params.sourcePath ?? ""}:${params.sourceRoot ?? ""}:${params.memoryId ?? ""}`;
			const existing = originNodeIds.get(sourceKey);
			if (existing) return existing;
			const id = `origin:${sourceKey}`;
			originNodeIds.set(sourceKey, id);
			addNode({
				id,
				label: source,
				kind: "origin",
				cluster: params.cluster,
				weight: 1,
				evidenceRefs: graphEvidenceRefs(params),
				metric: `${humanize(params.sourceKind ?? "source")} · evidence origin`,
			});
			return id;
		};
		for (const entity of entities) {
			const entityKind =
				entity.entityType === "source_document" || entity.entityType === "source_document_reference"
					? "source"
					: "entity";
			addNode({
				id: entity.id,
				label: entity.name,
				kind: entityKind,
				evidenceRefs:
					entityKind === "source"
						? [...new Set(entity.aspects.flatMap((aspect) => aspect.attributes.flatMap(graphEvidenceRefs)))]
						: [],
				cluster: entity.id,
				weight: Math.sqrt(entity.mentions / maxMentions),
				metric: `${entityKind} · ${entity.entityType} · ${entity.mentions.toLocaleString()} mentions`,
			});
			for (const aspect of entity.aspects) {
				addNode({
					id: aspect.id,
					label: aspect.name,
					kind: "aspect",
					cluster: entity.id,
					weight: aspect.weight,
					metric: `aspect · ${percent(aspect.weight)} weight`,
				});
				addEdge(entity.id, aspect.id, "contains");
				const groups = new Map<string, { id: string; count: number; weight: number }>();
				for (const attr of aspect.attributes) {
					const groupKey = attr.groupKey ?? "general";
					const groupId = `group:${aspect.id}:${groupKey}`;
					const group = groups.get(groupKey) ?? { id: groupId, count: 0, weight: 0 };
					group.count += 1;
					group.weight = Math.max(group.weight, attr.importance);
					groups.set(groupKey, group);
					const kind = attr.kind === "claim" ? "claim" : attr.kind === "constraint" ? "constraint" : "attribute";
					const attrLabel = shorten(attr.content || humanize(attr.claimKey ?? attr.kind), 68);
					const source = provenanceLabel(
						attr.sourceKind,
						attr.sourceId,
						attr.sourcePath,
						attr.sourceRoot,
						attr.memoryId,
					);
					const attributeNode: SceneNode = {
						id: attr.id,
						label: attrLabel,
						kind,
						cluster: entity.id,
						weight: attr.importance,
						confidence: attr.confidence,
						evidenceRefs: graphEvidenceRefs(attr),
						detail: attr.content,
						metric: `${attr.kind} · ${percent(attr.confidence)} confidence · ${source ?? "unattributed"}`,
					};
					addNode(attributeNode);
					attributeNodeIds.set(attr.id, attr.id);
					if (attr.claimKey) {
						const claimSlotId = `claim-slot:${aspect.id}:${groupKey}:${attr.claimKey}`;
						addNode({
							id: claimSlotId,
							label: humanize(attr.claimKey),
							kind: "claimSlot",
							cluster: entity.id,
							weight: attr.importance,
							metric: "claim slot · current value",
						});
						addEdge(groupId, claimSlotId, "organizes");
						addEdge(claimSlotId, attr.id, "describes");
					} else {
						addEdge(groupId, attr.id, "describes");
					}
					const originId = ensureOrigin({
						sourceKind: attr.sourceKind,
						sourceId: attr.sourceId,
						sourcePath: attr.sourcePath,
						sourceRoot: attr.sourceRoot,
						memoryId: null,
						cluster: entity.id,
					});
					if (attr.memoryId) {
						const memoryId = `memory:${attr.memoryId}`;
						addNode({
							id: memoryId,
							label: `Memory · ${shorten(attr.memoryId, 20)}`,
							kind: "memory",
							cluster: entity.id,
							weight: 1,
							metric: `Evidence reference · ${attr.memoryId}`,
						});
						addEdge(attr.id, memoryId, "evidenced_by");
						if (originId && (attr.sourceId || attr.sourcePath)) addEdge(memoryId, originId, "evidenced_by");
					} else if (originId) addEdge(attr.id, originId, "evidenced_by");
				}
				for (const [groupKey, group] of groups) {
					addNode({
						id: group.id,
						label: humanize(groupKey),
						kind: "group",
						cluster: entity.id,
						weight: group.weight,
						metric: `group · ${group.count} value${group.count === 1 ? "" : "s"}`,
					});
					addEdge(aspect.id, group.id, "organizes");
					for (const attr of aspect.attributes) {
						if ((attr.groupKey ?? "general") !== groupKey || attr.claimKey) continue;
						addEdge(group.id, attr.id, "describes");
					}
				}
			}
		}
		for (const assertion of graphQuery.data?.assertions ?? []) {
			if (!nodeIds.has(assertion.subjectEntityId)) continue;
			const source = provenanceLabel(
				assertion.sourceKind,
				assertion.sourceId,
				assertion.sourcePath,
				assertion.sourceRoot,
				null,
			);
			const assertionId = `assertion:${assertion.id}`;
			addNode({
				id: assertionId,
				label: shorten(assertion.content, 68),
				kind: "assertion",
				cluster: assertion.subjectEntityId,
				weight: assertion.confidence,
				confidence: assertion.confidence,
				evidenceRefs: graphEvidenceRefs(assertion),
				detail: assertion.content,
				metric: `${assertion.predicate} · ${percent(assertion.confidence)} confidence${
					assertion.speaker ? ` · ${assertion.speaker}` : ""
				}${assertion.evidenceCount > 0 ? ` · ${assertion.evidenceCount} evidence` : ""}${source ? ` · ${source}` : ""}`,
			});
			const target =
				assertion.claimAttributeId && attributeNodeIds.has(assertion.claimAttributeId)
					? assertion.claimAttributeId
					: assertion.subjectEntityId;
			addEdge(target, assertionId, "asserted_by", assertion.predicate, assertion.confidence);
			const originId = ensureOrigin({
				sourceKind: assertion.sourceKind,
				sourceId: assertion.sourceId,
				sourcePath: assertion.sourcePath,
				sourceRoot: assertion.sourceRoot,
				memoryId: null,
				cluster: assertion.subjectEntityId,
			});
			if (originId) addEdge(assertionId, originId, "evidenced_by");
		}
		for (const dependency of graphQuery.data?.dependencies ?? []) {
			addEdge(
				dependency.sourceEntityId,
				dependency.targetEntityId,
				"depends_on",
				dependency.dependencyType,
				dependency.strength,
			);
		}
		for (const source of sources ?? []) {
			addNode({
				id: `source:${source.id}`,
				label: source.name,
				kind: "source",
				cluster: "source",
				weight: 1,
				metric: `source · ${(source.stats?.indexed ?? 0).toLocaleString()} indexed`,
			});
		}
		return { nodes, edges };
	}, [graphQuery.data, sources]);
	const limitedScene = useMemo(() => capGraphSceneData(sceneData), [sceneData]);
	const dataSig = useMemo(() => {
		const entities = graphQuery.data?.entities ?? [];
		let h = entityLimit * 31 + entities.length + (sources?.length ?? 0) * 7;
		const mix = (value: string) => {
			for (let i = 0; i < value.length; i++) h = (h * 33 + value.charCodeAt(i)) | 0;
		};
		for (const e of entities) {
			mix(e.id);
			mix(e.name);
			mix(e.entityType);
			mix(String(e.mentions));
			for (const aspect of e.aspects) {
				mix(aspect.id);
				mix(String(aspect.weight));
				for (const attr of aspect.attributes) {
					mix(attr.id);
					mix(attr.content);
					mix(attr.kind);
					mix(String(attr.importance));
					mix(String(attr.confidence));
					mix(attr.memoryId ?? "");
					mix(attr.groupKey ?? "");
					mix(attr.claimKey ?? "");
					mix(attr.sourceKind ?? "");
					mix(attr.sourceId ?? "");
					mix(attr.sourcePath ?? "");
					mix(attr.sourceRoot ?? "");
				}
			}
		}
		for (const assertion of graphQuery.data?.assertions ?? []) {
			mix(assertion.id);
			mix(assertion.subjectEntityId);
			mix(assertion.claimAttributeId ?? "");
			mix(assertion.predicate);
			mix(assertion.content);
			mix(String(assertion.confidence));
			mix(assertion.speaker ?? "");
			mix(assertion.sourceKind ?? "");
			mix(assertion.sourceId ?? "");
			mix(assertion.sourcePath ?? "");
			mix(assertion.sourceRoot ?? "");
		}
		for (const dependency of graphQuery.data?.dependencies ?? []) {
			mix(dependency.sourceEntityId);
			mix(dependency.targetEntityId);
			mix(dependency.dependencyType);
			mix(String(dependency.strength));
		}
		for (const source of sources ?? []) {
			mix(source.id);
			mix(source.name);
			mix(String(source.stats?.indexed ?? 0));
		}
		return h;
	}, [graphQuery.data, sources]);
	useEffect(() => {
		const stage = stageRef.current;
		if (!stage) return;
		if (limitedScene.data.nodes.length === 0) {
			sceneRef.current?.dispose();
			sceneRef.current = null;
			builtSigRef.current = null;
			return;
		}
		if (sceneRef.current) {
			if (builtSigRef.current === dataSig) return;
			sceneRef.current.dispose();
			sceneRef.current = null;
			builtSigRef.current = null;
		}
		let cancelled = false;
		void import("@/lib/graph-scene")
			.then(({ createGraphScene }) => {
				if (cancelled || sceneRef.current || !stageRef.current) return;
				setSceneFailed(false);
				sceneRef.current = createGraphScene(
					stageRef.current,
					limitedScene.data,
					(node) => selectionRef.current(node),
					() => setSceneFailed(true),
				);
				builtSigRef.current = dataSig;
			})
			.catch((err: unknown) => {
				console.error("[graph] scene init failed", err);
				setSceneFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [limitedScene, dataSig]);
	useEffect(
		() => () => {
			sceneRef.current?.dispose();
			sceneRef.current = null;
		},
		[],
	);
	const pauseAgent = () => {
		sceneRef.current?.setFollowAgent(false);
	};
	const inspectEntity = (entityId: string) => {
		setInspected(null);
		const match = graphQuery.data?.entities.find((entity) => entity.id === entityId);
		if (!match) return;
		const aspects = [...match.aspects].sort((a, b) => b.weight - a.weight);
		const citations = aspects
			.flatMap((aspect) =>
				aspect.attributes.map((attr) => ({
					id: attr.id,
					text: attr.content,
					meta: `${aspect.name} · ${attr.kind} · v${attr.version}`,
				})),
			)
			.slice(0, 4);
		const edgeCount = (graphQuery.data?.dependencies ?? []).filter(
			(d) => d.sourceEntityId === match.id || d.targetEntityId === match.id,
		).length;
		setDetail({
			id: match.id,
			name: match.name,
			mentions: match.mentions,
			aspectCount: match.aspects.length,
			attributeCount: match.aspects.reduce((n, a) => n + a.attributes.length, 0),
			edgeCount,
			topAspects: aspects.slice(0, 4).map((a) => ({ name: a.name, weight: a.weight })),
			citations,
		});
		setResponded(true);
	};

	selectionRef.current = (node) => {
		const entity = graphQuery.data?.entities.find((entity) => entity.id === node.cluster);
		if (entity) inspectEntity(entity.id);
		else {
			setDetail(null);
			setResponded(true);
		}
		setInspected(node);
	};

	const closeResponse = () => {
		setInspected(null);
		setResponded(false);
		setDetail(null);
		sceneRef.current?.resetView();
	};

	const sidebarOpen = chatOpen;
	const [sidebarMounted, setSidebarMounted] = useState(false);
	useEffect(() => {
		if (sidebarOpen) {
			setSidebarMounted(true);
			return;
		}
		const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 420;
		const timer = setTimeout(() => setSidebarMounted(false), delay);
		return () => clearTimeout(timer);
	}, [sidebarOpen]);
	const sidebarPresented = sidebarOpen || sidebarMounted;
	const selection = (
		<Dialog
			open={responded}
			onOpenChange={(open) => {
				if (!open) closeResponse();
			}}
		>
			<DialogContent className="home-memory-reader">
				<DialogTitle>{inspected?.label ?? detail?.name ?? "Selection"}</DialogTitle>
				<DialogDescription>{inspected ? humanize(inspected.kind) : "Entity"} · Memory graph</DialogDescription>
				<div className="gr-body">
					{inspected && inspected.kind !== "entity" && (
						<div className="gr-answer">
							<div className="gr-section-label">
								{inspected.kind === "memory" || inspected.kind === "origin" ? "Evidence" : humanize(inspected.kind)}
							</div>
							<p>{inspected.detail ?? inspected.label}</p>
							<div className="gr-cite__meta">{inspected.metric}</div>
						</div>
					)}
					{detail ? (
						<>
							<div>
								<div className="gr-answer">
									<b>{detail.name}</b> — {detail.mentions.toLocaleString()} mentions across {detail.aspectCount} aspects
									and {detail.attributeCount} attributes, linked to {detail.edgeCount} neighboring entities.
									{detail.topAspects.length > 0 && (
										<>
											{" "}
											Strongest aspect: <b>{detail.topAspects[0].name}</b> (
											{Math.round(detail.topAspects[0].weight * 100)}% weight).
										</>
									)}
									<div className="gr-prov">
										<span className="dot" /> constellation · entity cluster
									</div>
								</div>
							</div>
							{detail.citations.length > 0 && (
								<div>
									<div className="gr-section-label" style={{ marginBottom: 8 }}>
										Stored values
									</div>
									<div className="flex flex-col gap-2">
										{detail.citations.map((cite) => (
											<div key={cite.id} className="gr-cite">
												<span className="gr-cite__dot" style={{ background: "#22d3ee" }} />
												<div>
													<div className="gr-cite__txt">{cite.text}</div>
													<div className="gr-cite__meta">{cite.meta}</div>
												</div>
											</div>
										))}
									</div>
								</div>
							)}
						</>
					) : (
						<div className="gr-answer">{inspected ? "" : "Select an entity to inspect its stored values."}</div>
					)}
				</div>
			</DialogContent>
		</Dialog>
	);

	return (
		<div className={cn("graph-view-root", sidebarOpen && "has-sidebar")}>
			<div className="graph-viewport">
				{!sidebarOpen && (
					<Button
						type="button"
						variant="ghost"
						size="icon-sm"
						className="graph-chat-open"
						aria-label="Open chat"
						title="Open chat"
						onClick={() => setChatOpen(true)}
					>
						<PanelRightOpenIcon className="size-4" />
					</Button>
				)}
				{limitedScene.capped && (
					<span className="graph-limit" role="status">
						Limited view
					</span>
				)}

				<button
					type="button"
					className="graph-legend-btn"
					title="Graph key and controls"
					aria-label="Graph key and controls"
					aria-expanded={legendOpen}
					onClick={() => setLegendOpen((open) => !open)}
				>
					<svg
						aria-hidden="true"
						viewBox="0 0 24 24"
						width="15"
						height="15"
						fill="none"
						stroke="currentColor"
						strokeWidth={1.75}
						strokeLinecap="round"
						strokeLinejoin="round"
					>
						<circle cx="12" cy="12" r="3" />
						<path d="M12 1v3M12 20v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M1 12h3M20 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1" />
					</svg>
				</button>
				<div className={cn("graph-legend-pop", legendOpen && "show")}>
					<span className="graph-key-summary">
						{graphQuery.data?.entities.length ?? 0} entities · {limitedScene.data.nodes.length.toLocaleString()} nodes ·{" "}
						{limitedScene.data.edges.length.toLocaleString()} links
					</span>
					{limitedScene.capped && (
						<span className="graph-key-limit" role="status">
							Showing up to {MAX_VISIBLE_CONSTELLATION_NODES.toLocaleString()} nodes
						</span>
					)}
					{LEGEND.map((item) => (
						<span key={item.label} className="lg-item" style={{ color: item.color }}>
							<span className="lg-dot" style={{ background: item.color }} />
							<b>{item.label}</b>
						</span>
					))}
					<div className="graph-key-help">
						<span>Drag to pan</span>
						<span>Scroll to zoom</span>
						<span>Select to inspect</span>
					</div>
				</div>

				<div ref={stageRef} className="graph-stage" />
				<fieldset className="graph-navigation" aria-label="Graph navigation">
					<button
						type="button"
						aria-label="Zoom in"
						onClick={() => {
							pauseAgent();
							sceneRef.current?.zoom(1.3);
						}}
					>
						+
					</button>
					<button
						type="button"
						aria-label="Zoom out"
						onClick={() => {
							pauseAgent();
							sceneRef.current?.zoom(1 / 1.3);
						}}
					>
						−
					</button>
					<button
						type="button"
						aria-label="Fit graph"
						title="Fit graph"
						onClick={() => {
							pauseAgent();
							sceneRef.current?.resetView();
						}}
					>
						Fit
					</button>
				</fieldset>
				{graphQuery.loading && !graphQuery.data && (
					<div
						role="status"
						aria-label="Loading constellation…"
						className="pointer-events-none absolute inset-0 z-[2] flex flex-col items-center justify-center gap-5"
					>
						<Skeleton className="size-32 rounded-full opacity-40" />
						<Skeleton className="h-2 w-36" />
						<span className="font-mono text-[10.5px] text-muted-foreground">Loading constellation…</span>
					</div>
				)}
				{graphQuery.error && (
					<span role="status" className="absolute left-4 top-14 z-[3] text-xs text-muted-foreground">
						{graphQuery.data
							? "Showing cached constellation. Updates are unavailable."
							: "Constellation unavailable. Retrying in the background."}
					</span>
				)}
				{!graphQuery.loading && !graphQuery.error && limitedScene.data.nodes.length === 0 && (
					<span className="pointer-events-none absolute inset-0 z-[2] grid place-items-center font-mono text-[10.5px] text-muted-foreground">
						No graph nodes are available yet.
					</span>
				)}
				{sceneFailed && (
					<span className="pointer-events-none absolute inset-0 z-[2] grid place-items-center font-mono text-[10.5px] text-muted-foreground">
						The memory graph could not render in this runtime.
					</span>
				)}
			</div>
			{selection}
			<MemoryChat
				className={sidebarPresented ? cn("graph-chat-sidebar", !sidebarOpen && "is-closing") : "graph-dock"}
				inactive={sidebarPresented && !sidebarOpen}
				presentation={sidebarPresented ? "sidebar" : "compact"}
				onClose={() => {
					setChatOpen(false);
					closeResponse();
				}}
				onNewChat={() => {
					setChatOpen(false);
					closeResponse();
				}}
				selectedEntityId={detail?.id}
				onFocusEntity={(id) => sceneRef.current?.setRetrieval([id], [])}
				onRetrieval={(ids, refs) => sceneRef.current?.setRetrieval(ids, refs)}
				onRetrievalClear={() => sceneRef.current?.clearRetrieval()}
				onTurnStart={() => {
					setChatOpen(true);
					sceneRef.current?.setFollowAgent(true);
				}}
				onMemoryChanged={() => graphQuery.refresh()}
			/>
		</div>
	);
}
