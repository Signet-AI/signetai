import { MemoryChat } from "@/components/memory-chat";
import { sourceDocumentTitle } from "@/lib/constellation-display";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { PanelRightOpenIcon, SearchIcon, XIcon } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import type {
	GraphSceneData,
	GraphSceneHandle,
	SceneEdge,
	SceneEdgeKind,
	SceneNode,
	SceneNodeKind,
} from "@/lib/graph-scene";
import { capGraphSceneData, graphEvidenceRefs, MAX_VISIBLE_CONSTELLATION_NODES } from "@/lib/constellation-display";

const ENTITY_LIMIT = 150;

const FILTERS: ReadonlyArray<{
	readonly key: string;
	readonly label: string;
	readonly kinds: readonly SceneNodeKind[];
}> = [
	{ key: "entity", label: "Entities", kinds: ["entity"] },
	{ key: "source", label: "Documents", kinds: ["source"] },
	{ key: "aspect", label: "Aspects", kinds: ["aspect", "group"] },
	{ key: "fact", label: "Facts", kinds: ["claimSlot", "attribute", "claim", "assertion"] },
	{ key: "constraint", label: "Constraints", kinds: ["constraint"] },
	{ key: "evidence", label: "Evidence", kinds: ["origin", "memory"] },
];

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

function nodeKindLabel(kind: SceneNodeKind): string {
	if (kind === "origin" || kind === "memory") return "Evidence";
	if (kind === "source") return "Document";
	if (kind === "claimSlot") return "Claim slot";
	return humanize(kind);
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
	const [sceneBuilt, setSceneBuilt] = useState(false);
	const [isolated, setIsolated] = useState<string | null>(null);
	const [hiddenFilters, setHiddenFilters] = useState<ReadonlySet<string>>(() => new Set());
	const [searchQuery, setSearchQuery] = useState("");
	const [searchOpen, setSearchOpen] = useState(false);
	const searchRef = useRef<HTMLInputElement>(null);
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
				label: entityKind === "source" ? sourceDocumentTitle(entity.name) : entity.name,
				kind: entityKind,
				...(entityKind === "source" ? { detail: entity.name } : {}),
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
			setSceneBuilt(false);
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
					undefined,
					setIsolated,
				);
				sceneRef.current.setHiddenKinds(hiddenKindsRef.current);
				builtSigRef.current = dataSig;
				setSceneBuilt(true);
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
			name: match.entityType === "source_document" ? sourceDocumentTitle(match.name) : match.name,
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
		const delay = window.matchMedia("(prefers-reduced-motion: reduce)").matches ? 0 : 200;
		const timer = setTimeout(() => setSidebarMounted(false), delay);
		return () => clearTimeout(timer);
	}, [sidebarOpen]);
	const sidebarPresented = sidebarOpen || sidebarMounted;
	const focusIsEntity = !inspected || inspected.kind === "entity" || inspected.id === detail?.id;
	const selection = responded && (
		<aside className="graph-inspector" aria-label="Selection details">
			<header className="graph-inspector-head">
				<div className="min-w-0">
					<span className="graph-inspector-kind">
						{nodeKindLabel(focusIsEntity ? "entity" : (inspected?.kind ?? "entity"))}
					</span>
					{focusIsEntity ? (
						<h2 className="graph-inspector-title">{detail?.name ?? inspected?.label ?? "Selection"}</h2>
					) : (
						<h2 className="graph-inspector-fact">{inspected?.detail ?? inspected?.label}</h2>
					)}
				</div>
				<button type="button" className="graph-inspector-close" aria-label="Close details" onClick={closeResponse}>
					<XIcon className="size-4" />
				</button>
			</header>
			<div className="graph-inspector-body">
				{!focusIsEntity && inspected && <p className="graph-inspector-meta -mt-2">{inspected.metric}</p>}
				{detail ? (
					<>
						<section>
							{!focusIsEntity && <h3 className="graph-inspector-label">About {detail.name}</h3>}
							<p className="graph-inspector-text">
								{detail.mentions.toLocaleString()} mentions across {detail.aspectCount} aspects and{" "}
								{detail.attributeCount} facts, linked to {detail.edgeCount} other entities.
								{detail.topAspects.length > 0 && (
									<>
										{" "}
										Strongest aspect: <b>{detail.topAspects[0].name}</b>.
									</>
								)}
							</p>
						</section>
						{detail.citations.length > 0 && (
							<section>
								<h3 className="graph-inspector-label">{focusIsEntity ? "Stored values" : "Other stored values"}</h3>
								<ul className="graph-inspector-list">
									{detail.citations
										.filter((cite) => cite.id !== inspected?.id)
										.map((cite) => (
											<li key={cite.id}>
												<p className="graph-inspector-text">{cite.text}</p>
												<p className="graph-inspector-meta">{cite.meta}</p>
											</li>
										))}
								</ul>
							</section>
						)}
						{isolated !== detail.id && (
							<button
								type="button"
								className="graph-inspector-action"
								onClick={() => sceneRef.current?.isolate(detail.id)}
							>
								Focus on this entity
							</button>
						)}
					</>
				) : (
					!inspected && <p className="graph-inspector-meta">Select an entity to inspect its stored values.</p>
				)}
			</div>
		</aside>
	);
	const hiddenKinds = useMemo(
		() => FILTERS.filter((filter) => hiddenFilters.has(filter.key)).flatMap((filter) => filter.kinds),
		[hiddenFilters],
	);
	const hiddenKindsRef = useRef<readonly SceneNodeKind[]>(hiddenKinds);
	hiddenKindsRef.current = hiddenKinds;
	useEffect(() => {
		sceneRef.current?.setHiddenKinds(hiddenKinds);
	}, [hiddenKinds]);
	const searchResults = useMemo(() => {
		const query = searchQuery.trim().toLowerCase();
		if (!query) return [];
		return limitedScene.data.nodes
			.filter((node) => (node.kind === "entity" || node.kind === "source") && node.label.toLowerCase().includes(query))
			.sort(
				(a, b) =>
					Number(b.label.toLowerCase().startsWith(query)) - Number(a.label.toLowerCase().startsWith(query)) ||
					Number(b.kind === "entity") - Number(a.kind === "entity") ||
					b.weight - a.weight,
			)
			.slice(0, 8);
	}, [searchQuery, limitedScene]);
	const jumpTo = (node: SceneNode) => {
		pauseAgent();
		sceneRef.current?.focusNode(node.id);
		selectionRef.current(node);
		setSearchQuery("");
		setSearchOpen(false);
		searchRef.current?.blur();
	};
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.key !== "/" || event.metaKey || event.ctrlKey || event.altKey) return;
			const target = event.target;
			if (
				target instanceof HTMLElement &&
				(target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA")
			)
				return;
			event.preventDefault();
			searchRef.current?.focus();
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	return (
		<div className={cn("graph-view-root", sidebarPresented && "has-sidebar")}>
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
					{FILTERS.map((filter) => {
						const off = hiddenFilters.has(filter.key);
						return (
							<button
								key={filter.key}
								type="button"
								className="lg-item"
								aria-pressed={!off}
								onClick={() =>
									setHiddenFilters((current) => {
										const next = new Set(current);
										if (next.has(filter.key)) next.delete(filter.key);
										else next.add(filter.key);
										return next;
									})
								}
							>
								<span className="lg-dot" data-kind={filter.key} />
								{filter.label}
							</button>
						);
					})}
					<div className="graph-key-help">
						<span>Drag to pan</span>
						<span>Scroll to zoom</span>
						<span>Click to inspect · double-click to focus</span>
						<span>Press / to find</span>
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
				<search className="graph-search">
					<SearchIcon className="size-3.5 shrink-0" aria-hidden="true" />
					<input
						ref={searchRef}
						value={searchQuery}
						onChange={(event) => {
							setSearchQuery(event.target.value);
							setSearchOpen(true);
						}}
						onFocus={() => setSearchOpen(true)}
						onBlur={() => setTimeout(() => setSearchOpen(false), 120)}
						onKeyDown={(event) => {
							if (event.key === "Enter" && searchResults[0]) jumpTo(searchResults[0]);
							if (event.key === "Escape") {
								setSearchQuery("");
								event.currentTarget.blur();
							}
						}}
						placeholder="Find in graph"
						aria-label="Find a node in the graph"
					/>
					<kbd title="Press / to search">/</kbd>
					{searchOpen && searchQuery.trim() && (
						<ul className="graph-search-results">
							{searchResults.length ? (
								searchResults.map((node) => (
									<li key={node.id}>
										<button type="button" onMouseDown={(event) => event.preventDefault()} onClick={() => jumpTo(node)}>
											<span className="graph-search-dot" data-kind={node.kind} aria-hidden="true" />
											<span className="truncate">{node.label}</span>
											<span className="graph-search-kind">{node.kind === "entity" ? "Entity" : "Document"}</span>
										</button>
									</li>
								))
							) : (
								<li className="graph-search-empty">No matching entities or documents</li>
							)}
						</ul>
					)}
				</search>
				{isolated && (
					<button type="button" className="graph-isolation" onClick={() => sceneRef.current?.isolate(null)}>
						<XIcon className="size-3.5" aria-hidden="true" />
						Back to all
					</button>
				)}
				{((graphQuery.loading && !graphQuery.data) ||
					(!sceneBuilt && !sceneFailed && limitedScene.data.nodes.length > 0)) && (
					<div
						role="status"
						aria-label="Loading constellation…"
						className="pointer-events-none absolute inset-0 z-[2] flex flex-col items-center justify-center gap-5"
					>
						<Skeleton className="size-32 rounded-full opacity-40" />
						<Skeleton className="h-2 w-36" />
						<span className="text-small text-muted-foreground">Loading your memory graph…</span>
					</div>
				)}
				{graphQuery.error && (
					<span role="status" className="absolute left-4 top-14 z-[3] text-small text-muted-foreground">
						{graphQuery.data
							? "Showing cached constellation. Updates are unavailable."
							: "Constellation unavailable. Retrying in the background."}
					</span>
				)}
				{!graphQuery.loading && !graphQuery.error && limitedScene.data.nodes.length === 0 && (
					<span className="pointer-events-none absolute inset-0 z-[2] grid place-items-center text-small text-muted-foreground">
						No graph nodes are available yet.
					</span>
				)}
				{sceneFailed && (
					<span className="pointer-events-none absolute inset-0 z-[2] grid place-items-center text-small text-muted-foreground">
						The memory graph could not render in this runtime.
					</span>
				)}
				{selection}
			</div>
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
