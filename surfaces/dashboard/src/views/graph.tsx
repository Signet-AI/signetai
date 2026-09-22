import { Network } from "@/components/mingcute-icons";
import { useEffect, useMemo, useRef, useState } from "react";
import { api } from "@/lib/api";
import { useAsync } from "@/lib/use-async";
import { cn } from "@/lib/utils";
import type { GraphSceneData, GraphSceneHandle, SceneEdge, SceneEdgeKind, SceneNode } from "@/lib/graph-scene";

const LEGEND = [
	{ color: "#ffffff", label: "subject" },
	{ color: "#34d399", label: "aspect" },
	{ color: "#60a5fa", label: "group" },
	{ color: "#f59e0b", label: "claim slot" },
	{ color: "#fbbf24", label: "claim" },
	{ color: "#fb7185", label: "constraint" },
	{ color: "#f472b6", label: "assertion" },
	{ color: "#22d3ee", label: "evidence" },
	{ color: "#38bdf8", label: "source" },
] as const;
const ENTITY_LIMIT_MAX = 1000;

interface EntityDetail {
	id: string;
	name: string;
	mentions: number;
	aspectCount: number;
	attributeCount: number;
	edgeCount: number;
	topAspects: { name: string; weight: number }[];
	citations: { text: string; meta: string }[];
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
	const [entityLimit, setEntityLimit] = useState(48);
	const graphQuery = useAsync(() => api.getKnowledgeConstellation(entityLimit, Math.min(2000, entityLimit * 4)), {
		intervalMs: 30_000,
		deps: [entityLimit],
	});
	const stats = useAsync(() => api.getKnowledgeStats(), { intervalMs: 30_000 }).data;
	const sources = useAsync(() => api.getSources(), { intervalMs: 30_000 }).data?.sources;
	const [legendOpen, setLegendOpen] = useState(false);
	const [detail, setDetail] = useState<EntityDetail | null>(null);
	const [responded, setResponded] = useState(false);
	const [query, setQuery] = useState("");
	const [followup, setFollowup] = useState("");
	const [logOpen, setLogOpen] = useState(false);
	const [sceneFailed, setSceneFailed] = useState(false);
	const [sliderPct, setSliderPct] = useState<number | null>(null);
	const stageRef = useRef<HTMLDivElement>(null);
	const sceneRef = useRef<GraphSceneHandle | null>(null);
	const builtSigRef = useRef<number | null>(null);
	const densityTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

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
						memoryId: attr.memoryId,
						cluster: entity.id,
					});
					if (originId) addEdge(attr.id, originId, "evidenced_by");
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
	}, [graphQuery.data, sources, entityLimit]);
	useEffect(() => {
		const stage = stageRef.current;
		if (!stage || sceneData.nodes.length === 0) return;
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
				sceneRef.current = createGraphScene(stageRef.current, sceneData);
				builtSigRef.current = dataSig;
				setSliderPct(null);
			})
			.catch((err: unknown) => {
				console.error("[graph] scene init failed", err);
				setSceneFailed(true);
			});
		return () => {
			cancelled = true;
		};
	}, [sceneData, dataSig]);
	useEffect(
		() => () => {
			if (densityTimerRef.current) clearTimeout(densityTimerRef.current);
			sceneRef.current?.dispose();
			sceneRef.current = null;
		},
		[],
	);
	const totalNodes = stats
		? stats.entityCount +
			stats.aspectCount +
			stats.attributeCount +
			(stats.claimCount ?? 0) +
			(stats.constraintCount ?? 0)
		: 0;
	const shownEntities = Math.max(1, graphQuery.data?.entities.length ?? 48);
	const nodesPerEntity = Math.max(1, sceneData.nodes.length / shownEntities);
	const maxPct =
		totalNodes > 0 ? Math.max(2, Math.min(20, ((ENTITY_LIMIT_MAX * nodesPerEntity) / totalNodes) * 100)) : 5;
	const shownPct = totalNodes > 0 ? (sceneData.nodes.length / totalNodes) * 100 : 0;
	const displayPct = sliderPct ?? shownPct;
	const onDensityChange = (pct: number) => {
		setSliderPct(pct);
		if (densityTimerRef.current) clearTimeout(densityTimerRef.current);
		densityTimerRef.current = setTimeout(() => {
			const targetNodes = (pct / 100) * totalNodes;
			const limit = Math.max(8, Math.min(ENTITY_LIMIT_MAX, Math.round(targetNodes / nodesPerEntity)));
			setEntityLimit(limit);
		}, 350);
	};

	const runQuery = (raw: string) => {
		const q = raw.trim().toLocaleLowerCase();
		if (!q) return;
		const entities = graphQuery.data?.entities ?? [];
		const match =
			entities.find((e) => e.name.toLocaleLowerCase() === q) ??
			entities.find((e) => e.name.toLocaleLowerCase().includes(q)) ??
			entities.find((e) => q.includes(e.name.toLocaleLowerCase()));
		if (!match) {
			setDetail(null);
			setResponded(true);
			sceneRef.current?.resetView();
			return;
		}
		const aspects = [...match.aspects].sort((a, b) => b.weight - a.weight);
		const citations = aspects
			.flatMap((aspect) =>
				aspect.attributes.map((attr) => ({
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
		sceneRef.current?.focusNode(match.id, true);
	};

	const closeResponse = () => {
		setResponded(false);
		setDetail(null);
		setLogOpen(false);
		sceneRef.current?.resetView();
	};

	return (
		<div className="graph-view-root">
			{}
			<div className="graph-hud">
				<span>
					<b>{sceneData.nodes.length.toLocaleString()}</b> nodes
				</span>
				<span className="graph-hud__sep">/</span>
				<span>
					<b>{sceneData.edges.length.toLocaleString()}</b> edges
				</span>
				<span className="graph-hud__sep">/</span>
				<span>
					<b>{graphQuery.data?.entities.length ?? 0}</b> clusters
				</span>
				<span className="graph-hud__sep">/</span>
				<label className="graph-hud-density">
					density
					<input
						type="range"
						min={Math.min(1, maxPct)}
						max={maxPct}
						step={Math.max(0.1, maxPct / 50)}
						value={Math.max(Math.min(1, maxPct), Math.min(maxPct, displayPct))}
						disabled={totalNodes === 0}
						onChange={(event) => onDensityChange(Number(event.target.value))}
						aria-label="Graph density (percent of nodes shown)"
					/>
					<b>{displayPct.toFixed(1)}%</b>
				</label>
			</div>

			{}
			<button
				type="button"
				className="graph-legend-btn"
				title="Node categories"
				aria-expanded={legendOpen}
				onClick={() => setLegendOpen((open) => !open)}
			>
				<svg
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
				{LEGEND.map((item) => (
					<span key={item.label} className="lg-item" style={{ color: item.color }}>
						<span className="lg-dot" style={{ background: item.color }} />
						<b>{item.label}</b>
					</span>
				))}
			</div>

			{}
			<div ref={stageRef} className="graph-stage" />
			{graphQuery.loading && (
				<span className="pointer-events-none absolute inset-0 z-[2] grid place-items-center font-mono text-[10.5px] text-muted-foreground">
					Loading constellation…
				</span>
			)}
			{!graphQuery.loading && sceneData.nodes.length === 0 && (
				<span className="pointer-events-none absolute inset-0 z-[2] grid place-items-center font-mono text-[10.5px] text-muted-foreground">
					No graph nodes are available yet.
				</span>
			)}
			{sceneFailed && (
				<span className="pointer-events-none absolute inset-0 z-[2] grid place-items-center font-mono text-[10.5px] text-muted-foreground">
					WebGL is unavailable — the 3D constellation cannot render in this runtime.
				</span>
			)}

			{}
			<div className={cn("graph-response", responded && "show")}>
				<div className="gr-head">
					<span className="gr-avatar">
						<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" strokeWidth={1.6}>
							<circle cx="6" cy="8" r="2" />
							<circle cx="18" cy="8" r="2" />
							<circle cx="12" cy="16" r="2.5" />
							<path d="M7.5 9.5 10.5 14M16.5 9.5 13.5 14" />
						</svg>
					</span>
					<div className="gr-head-txt">
						<span className="gr-label">Signet</span>
						<div className="gr-title">{detail ? detail.name : "No match"}</div>
					</div>
					<button type="button" className="gr-close" aria-label="Close" onClick={closeResponse}>
						<svg
							viewBox="0 0 24 24"
							width="15"
							height="15"
							fill="none"
							stroke="currentColor"
							strokeWidth={2}
							strokeLinecap="round"
						>
							<path d="M18 6 6 18M6 6l12 12" />
						</svg>
					</button>
				</div>
				<div className="gr-body">
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
										Citations
									</div>
									<div className="flex flex-col gap-2">
										{detail.citations.map((cite, i) => (
											<div key={i} className="gr-cite">
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
							<div className={cn("gr-acc", logOpen && "open")}>
								<button type="button" className="gr-acc-trigger" onClick={() => setLogOpen((open) => !open)}>
									<svg
										viewBox="0 0 24 24"
										width="10"
										height="10"
										fill="none"
										stroke="currentColor"
										strokeWidth={2.5}
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<path d="m9 18 6-6-6-6" />
									</svg>
									Execution log
								</button>
								<div className="gr-acc-body">
									<div>constellation(local, top=48) → {graphQuery.data?.entities.length ?? 0} entities</div>
									<div>cluster resolved ({detail.aspectCount + detail.attributeCount + 1} nodes)</div>
								</div>
							</div>
						</>
					) : (
						<div className="gr-answer">No cluster matched.</div>
					)}
				</div>
				<div className="gr-dock">
					<div className="gr-dock-input">
						<input
							aria-label="Ask a follow-up"
							placeholder="Ask a follow-up…"
							value={followup}
							onChange={(event) => setFollowup(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && followup.trim()) {
									runQuery(followup);
									setFollowup("");
								}
							}}
						/>
					</div>
					<button
						type="button"
						className="gr-send-pill"
						aria-label="Send follow-up"
						disabled={!followup.trim()}
						onClick={() => {
							runQuery(followup);
							setFollowup("");
						}}
					>
						<svg
							viewBox="0 0 24 24"
							width="15"
							height="15"
							fill="none"
							stroke="currentColor"
							strokeWidth={2}
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M5 12h14M13 6l6 6-6 6" />
						</svg>
					</button>
				</div>
			</div>

			{}
			<form
				className={cn("graph-dock", responded && "responded")}
				onSubmit={(event) => {
					event.preventDefault();
					if (!query.trim()) return;
					runQuery(query);
					setQuery("");
				}}
			>
				<div className="dock-row">
					<span className="gd-icon">
						<Network className="size-[18px]" />
					</span>
					<input
						className="gd-input"
						aria-label="Ask Signet about your memories"
						placeholder="Ask Signet about your memories…"
						value={query}
						onChange={(event) => setQuery(event.target.value)}
					/>
					<kbd className="gd-kbd">⏎</kbd>
					<button type="submit" className="gd-send" aria-label="Send" disabled={!query.trim()}>
						<svg
							viewBox="0 0 24 24"
							width="17"
							height="17"
							fill="none"
							stroke="currentColor"
							strokeWidth={2}
							strokeLinecap="round"
							strokeLinejoin="round"
						>
							<path d="M5 12h14M13 6l6 6-6 6" />
						</svg>
					</button>
				</div>
			</form>
		</div>
	);
}
