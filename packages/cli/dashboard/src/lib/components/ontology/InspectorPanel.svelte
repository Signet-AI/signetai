<script lang="ts">
	import { Badge } from "$lib/components/ui/badge/index.js";
	import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
	import User from "@lucide/svelte/icons/user";
	import Hexagon from "@lucide/svelte/icons/hexagon";
	import CircleDot from "@lucide/svelte/icons/circle-dot";
	import Table2 from "@lucide/svelte/icons/table-2";
	import ArrowLeft from "@lucide/svelte/icons/arrow-left";
	import type { KnowledgeAttribute } from "$lib/api";
	import {
		ontology,
		loadEntityDetail,
		loadAspectDetail,
		selectNode,
	} from "./ontology-state.svelte";
	import { entityNameFromGraph, NODE_COLORS } from "./ontology-data";

	interface Props {
		agentId?: string;
	}
	const { agentId = "default" }: Props = $props();

	// Load entity detail when entity or agentId changes
	let lastEntityKey = "";
	$effect(() => {
		const sel = ontology.selected;
		const key = sel?.kind === "entity" ? `${sel.id}@${agentId}` : "";
		if (key && key !== lastEntityKey) {
			lastEntityKey = key;
			loadEntityDetail(sel!.id, agentId);
		} else if (!key) {
			lastEntityKey = "";
		}
	});

	// Load aspect attributes when aspect/attribute or agentId changes
	let lastAspectKey = "";
	$effect(() => {
		const sel = ontology.selected;
		if (sel?.kind === "aspect") {
			const key = `${sel.id}@${agentId}`;
			if (key !== lastAspectKey) {
				lastAspectKey = key;
				loadAspectDetail(sel.id, sel.id, agentId);
			}
		} else if (sel?.kind === "attribute") {
			const node = ontology.graphNodes.find((n) => n.id === sel.id && n.kind === "attribute");
			if (node?.parentId) {
				const key = `${node.parentId}@${agentId}`;
				if (key !== lastAspectKey) {
					lastAspectKey = key;
					// Pass the attribute's own ID as triggeredBy so the guard in
					// loadAspectDetail can check selected.id === attributeId, not aspectId
					loadAspectDetail(node.parentId, sel.id, agentId);
				}
			}
		} else {
			lastAspectKey = "";
		}
	});

	const tableStats = $derived(ontology.tableStats);

	// --- Entity derived state ---

	const entity = $derived(
		ontology.selected?.kind === "entity"
			? ontology.entities.find((e) => e.id === ontology.selected?.id)
			: undefined,
	);

	const detail = $derived(ontology.detail);
	const aspects = $derived(ontology.detailAspects);
	const attrs = $derived(ontology.detailAttributes);
	const deps = $derived(ontology.detailDependencies);

	// --- Aspect derived state ---

	const aspectNode = $derived(
		ontology.selected?.kind === "aspect"
			? ontology.graphNodes.find(
					(n) => n.id === ontology.selected?.id && n.kind === "aspect",
				)
			: undefined,
	);

	const aspectParent = $derived(
		aspectNode?.parentId
			? ontology.graphNodes.find(
					(n) => n.id === aspectNode.parentId && n.kind === "entity",
				)
			: undefined,
	);

	const aspectAttrs = $derived(ontology.aspectAttrs);

	// --- Attribute derived state ---

	const attrNode = $derived(
		ontology.selected?.kind === "attribute"
			? ontology.graphNodes.find(
					(n) => n.id === ontology.selected?.id && n.kind === "attribute",
				)
			: undefined,
	);

	const attrParentAspect = $derived(
		attrNode?.parentId
			? ontology.graphNodes.find(
					(n) => n.id === attrNode.parentId && n.kind === "aspect",
				)
			: undefined,
	);

	const attrParentEntity = $derived(
		attrParentAspect?.parentId
			? ontology.graphNodes.find(
					(n) => n.id === attrParentAspect.parentId && n.kind === "entity",
				)
			: undefined,
	);

	// Look up full attribute data from loaded aspect attrs
	const selectedAttr = $derived.by((): KnowledgeAttribute | undefined => {
		if (!attrNode) return undefined;
		const found = ontology.aspectAttrs.find((a) => a.id === attrNode.id);
		if (found) return found;
		// Fallback: build partial from graph node data
		const data = attrNode.data as Record<string, unknown> | null;
		return {
			id: attrNode.id,
			aspectId: attrNode.parentId ?? "",
			agentId: "default",
			memoryId: null,
			kind: (attrNode.sublabel === "constraint" ? "constraint" : "attribute") as
				| "attribute"
				| "constraint",
			content: typeof data?.content === "string" ? data.content : attrNode.label,
			normalizedContent: "",
			confidence: typeof data?.confidence === "number" ? data.confidence : 0,
			importance: typeof data?.importance === "number" ? data.importance : 0,
			status: "active",
			supersededBy: null,
			createdAt: "",
			updatedAt: "",
		};
	});

	function formatDate(iso: string): string {
		return new Date(iso).toLocaleString("en-US", {
			month: "short",
			day: "numeric",
			hour: "2-digit",
			minute: "2-digit",
		});
	}

	function entityName(id: string): string {
		return entityNameFromGraph(ontology.entities, id);
	}

	function navigateTo(id: string, kind: "entity" | "aspect" | "attribute"): void {
		selectNode(id, kind);
	}
</script>

<div class="inspector-panel">
	<div class="panel-header">
		<span class="panel-title">INSPECTOR</span>
		{#if ontology.loadingDetail || ontology.loadingAspect}
			<span class="panel-status">Loading...</span>
		{/if}
	</div>

	<ScrollArea class="flex-1 min-h-0">
		<div class="inspector-body">
			{#if entity}
				<!-- ========== ENTITY VIEW ========== -->
				<div class="inspector-header-row">
					<div class="entity-icon">
						<User class="size-4 text-[var(--sig-electric)]" />
					</div>
					<div class="entity-name-block">
						<span class="entity-display-name">{entity.name}</span>
						<span class="entity-canonical">{entity.entityType}</span>
					</div>
				</div>

				<div class="section">
					<div class="section-label">META</div>
					<div class="meta-grid">
						<div class="meta-row">
							<span class="meta-key">id</span>
							<span class="meta-val mono">{entity.id}</span>
						</div>
						<div class="meta-row">
							<span class="meta-key">type</span>
							<Badge variant="outline" class="meta-badge">{entity.entityType}</Badge>
						</div>
						<div class="meta-row">
							<span class="meta-key">mentions</span>
							<span class="meta-val mono">{entity.mentions}</span>
						</div>
						{#if detail?.entity.createdAt}
							<div class="meta-row">
								<span class="meta-key">created</span>
								<span class="meta-val mono"
									>{formatDate(detail.entity.createdAt)}</span
								>
							</div>
						{/if}
					</div>
				</div>

				{#if detail?.entity.description}
					<div class="section">
						<div class="section-label">DESCRIPTION</div>
						<p class="desc-text">{detail.entity.description}</p>
					</div>
				{/if}

				{#if aspects.length > 0}
					<div class="section">
						<div class="section-label">
							ASPECTS <span class="count-inline">{aspects.length}</span>
						</div>
						<div class="aspect-cards">
							{#each aspects as asp (asp.aspect.id)}
								<button
									class="aspect-card aspect-card-clickable"
									onclick={() => navigateTo(asp.aspect.id, "aspect")}
									type="button"
								>
									<div class="aspect-header">
										<span class="aspect-name"
											>{asp.aspect.canonicalName ?? asp.aspect.name}</span
										>
										<span class="aspect-weight"
											>w:{asp.aspect.weight.toFixed(2)}</span
										>
									</div>
									{#if attrs.get(asp.aspect.id)?.length}
										<span class="aspect-attr-count">
											{attrs.get(asp.aspect.id)?.length} attributes
										</span>
									{/if}
								</button>
							{/each}
						</div>
					</div>
				{/if}

				{#if deps.length > 0}
					<div class="section">
						<div class="section-label">
							DEPENDENCIES <span class="count-inline">{deps.length}</span>
						</div>
						<div class="dep-list">
							{#each deps as dep (dep.id)}
								{@const isOutgoing = dep.direction === "outgoing"}
								{@const otherId = isOutgoing
									? dep.targetEntityId
									: dep.sourceEntityId}
								<div class="dep-row">
									<span class="dep-direction"
										>{isOutgoing ? "-->" : "<--"}</span
									>
									<Badge variant="outline" class="dep-type-badge"
										>{dep.dependencyType}</Badge
									>
									<button
										class="dep-target"
										onclick={() => navigateTo(otherId, "entity")}
										type="button"
									>
										{entityName(otherId)}
									</button>
									<span class="dep-strength">{dep.strength.toFixed(2)}</span>
								</div>
							{/each}
						</div>
					</div>
				{/if}
			{:else if aspectNode}
				<!-- ========== ASPECT VIEW ========== -->
				<div class="inspector-header-row">
					<div class="node-icon aspect-bg">
						<Hexagon class="size-4" style="color: {NODE_COLORS.aspect}" />
					</div>
					<div class="entity-name-block">
						<span class="entity-display-name">{aspectNode.label}</span>
						<span class="entity-canonical"
							>aspect &middot; {aspectNode.sublabel}</span
						>
					</div>
				</div>

				{#if aspectParent}
					<div class="section">
						<div class="section-label">PARENT ENTITY</div>
						<button
							class="nav-back"
							onclick={() =>
								aspectParent && navigateTo(aspectParent.id, "entity")}
							type="button"
						>
							<ArrowLeft class="size-3" />
							<span>{aspectParent.label}</span>
						</button>
					</div>
				{/if}

				<div class="section">
					<div class="section-label">META</div>
					<div class="meta-grid">
						<div class="meta-row">
							<span class="meta-key">id</span>
							<span class="meta-val mono">{aspectNode.id}</span>
						</div>
					</div>
				</div>

				<div class="section">
					<div class="section-label">
						ATTRIBUTES
						{#if ontology.loadingAspect}
							<span class="panel-status">loading...</span>
						{:else}
							<span class="count-inline">{aspectAttrs.length}</span>
						{/if}
					</div>
					{#if aspectAttrs.length > 0}
						<div class="attr-cards">
							{#each aspectAttrs as attr (attr.id)}
								<button
									class="attr-card"
									class:attr-card-selected={ontology.selected?.id === attr.id}
									onclick={() => navigateTo(attr.id, "attribute")}
									type="button"
								>
									<div class="attr-card-header">
										<Badge variant="outline" class="attr-kind-badge"
											>{attr.kind}</Badge
										>
										<span class="attr-score">
											c:{attr.confidence.toFixed(2)} i:{attr.importance.toFixed(2)}
										</span>
									</div>
									<p class="attr-card-content">{attr.content}</p>
								</button>
							{/each}
						</div>
					{:else if !ontology.loadingAspect}
						<div class="empty-hint">No attributes</div>
					{/if}
				</div>
			{:else if attrNode && selectedAttr}
				<!-- ========== ATTRIBUTE VIEW ========== -->
				<div class="inspector-header-row">
					<div class="node-icon attr-bg">
						<CircleDot class="size-4" style="color: {NODE_COLORS.attribute}" />
					</div>
					<div class="entity-name-block">
						<span class="entity-display-name">{selectedAttr.kind}</span>
						<span class="entity-canonical">attribute</span>
					</div>
				</div>

				<!-- Breadcrumb navigation -->
				<div class="section">
					<div class="section-label">LOCATION</div>
					<div class="breadcrumb">
						{#if attrParentEntity}
							<button
								class="breadcrumb-link"
								onclick={() =>
									attrParentEntity &&
									navigateTo(attrParentEntity.id, "entity")}
								type="button"
							>
								{attrParentEntity.label}
							</button>
							<span class="breadcrumb-sep">&rsaquo;</span>
						{/if}
						{#if attrParentAspect}
							<button
								class="breadcrumb-link"
								onclick={() =>
									attrParentAspect &&
									navigateTo(attrParentAspect.id, "aspect")}
								type="button"
							>
								{attrParentAspect.label}
							</button>
						{/if}
					</div>
				</div>

				<div class="section">
					<div class="section-label">CONTENT</div>
					<p class="desc-text">{selectedAttr.content}</p>
				</div>

				<div class="section">
					<div class="section-label">META</div>
					<div class="meta-grid">
						<div class="meta-row">
							<span class="meta-key">id</span>
							<span class="meta-val mono">{selectedAttr.id}</span>
						</div>
						<div class="meta-row">
							<span class="meta-key">kind</span>
							<Badge variant="outline" class="meta-badge"
								>{selectedAttr.kind}</Badge
							>
						</div>
						<div class="meta-row">
							<span class="meta-key">confidence</span>
							<span class="meta-val mono"
								>{selectedAttr.confidence.toFixed(3)}</span
							>
						</div>
						<div class="meta-row">
							<span class="meta-key">importance</span>
							<span class="meta-val mono"
								>{selectedAttr.importance.toFixed(3)}</span
							>
						</div>
						<div class="meta-row">
							<span class="meta-key">status</span>
							<span class="meta-val mono">{selectedAttr.status}</span>
						</div>
						{#if selectedAttr.createdAt}
							<div class="meta-row">
								<span class="meta-key">created</span>
								<span class="meta-val mono"
									>{formatDate(selectedAttr.createdAt)}</span
								>
							</div>
						{/if}
					</div>
				</div>

				{#if attrParentAspect}
					<div class="section">
						<button
							class="nav-back"
							onclick={() =>
								attrParentAspect &&
								navigateTo(attrParentAspect.id, "aspect")}
							type="button"
						>
							<ArrowLeft class="size-3" />
							<span>Back to {attrParentAspect.label}</span>
						</button>
					</div>
				{/if}
			{:else if tableStats}
				<!-- ========== TABLE STATS VIEW ========== -->
				<div class="inspector-header-row">
					<div class="node-icon table-bg">
						<Table2 class="size-4 text-[var(--sig-text-muted)]" />
					</div>
					<div class="entity-name-block">
						<span class="entity-display-name">{tableStats.table}</span>
						<span class="entity-canonical">schema table</span>
					</div>
				</div>

				<div class="section">
					<div class="section-label">STATS</div>
					<div class="meta-grid">
						{#if tableStats.rows >= 0}
							<div class="meta-row">
								<span class="meta-key">rows</span>
								<span class="meta-val mono"
									>{tableStats.rows.toLocaleString()}</span
								>
							</div>
						{:else}
							<div class="meta-row">
								<span class="meta-key">rows</span>
								<span class="meta-val mono">--</span>
							</div>
						{/if}
						{#if tableStats.extra}
							{@const CURATED_KEYS = ["entityCount", "aspectCount", "attributeCount", "constraintCount", "dependencyCount", "coveragePercent", "averageAspectWeight", "total", "pinned", "decay"]}
							{#each Object.entries(tableStats.extra).filter(([k]) => CURATED_KEYS.includes(k) || typeof tableStats.extra?.[k] === "number") as [key, val] (key)}
								{#if typeof val === "number"}
									<div class="meta-row">
										<span class="meta-key">{key.replace(/([A-Z])/g, " $1").replace(/^./, (s) => s.toUpperCase()).trim()}</span>
										<span class="meta-val mono">
											{key.includes("ercent") || key.includes("eight")
												? `${(val * 100).toFixed(1)}%`
												: val.toLocaleString()}
										</span>
									</div>
								{/if}
							{/each}
						{/if}
					</div>
				</div>

				{#if ontology.loadingTable}
					<div class="empty-state">
						<span class="empty-label">Loading...</span>
					</div>
				{/if}
			{:else}
				<div class="empty-state">
					<span class="empty-label">
						{ontology.loading ? "Loading graph..." : "Select an entity or table"}
					</span>
				</div>
			{/if}
		</div>
	</ScrollArea>
</div>

<style>
	.inspector-panel {
		display: flex;
		flex-direction: column;
		height: 100%;
		min-height: 0;
		background: var(--sig-surface);
	}

	.panel-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 12px;
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.panel-title {
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.panel-status {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
	}

	.inspector-body {
		padding: 10px 12px;
	}

	/* Header row (icon + name) */
	.inspector-header-row {
		display: flex;
		align-items: center;
		gap: 10px;
		margin-bottom: 14px;
	}

	.entity-icon {
		width: 32px;
		height: 32px;
		border-radius: 6px;
		background: var(--sig-electric-dim);
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.node-icon {
		width: 32px;
		height: 32px;
		border-radius: 6px;
		display: flex;
		align-items: center;
		justify-content: center;
		flex-shrink: 0;
	}

	.aspect-bg {
		background: rgba(139, 92, 246, 0.12);
	}
	.attr-bg {
		background: rgba(6, 182, 212, 0.12);
	}
	.table-bg {
		background: rgba(107, 114, 128, 0.1);
	}

	.entity-name-block {
		display: flex;
		flex-direction: column;
		gap: 2px;
		min-width: 0;
	}

	.entity-display-name {
		font-family: var(--font-display);
		font-size: 14px;
		font-weight: 600;
		color: var(--sig-text-bright);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.entity-canonical {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	/* Sections */
	.section {
		margin-bottom: 14px;
	}

	.section-label {
		font-family: var(--font-mono);
		font-size: 9px;
		font-weight: 600;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
		margin-bottom: 6px;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.count-inline {
		font-weight: 400;
		opacity: 0.6;
	}

	/* Meta grid */
	.meta-grid {
		display: flex;
		flex-direction: column;
		gap: 3px;
	}

	.meta-row {
		display: flex;
		align-items: center;
		gap: 8px;
		min-height: 20px;
	}

	.meta-key {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		min-width: 70px;
		flex-shrink: 0;
	}

	.meta-val {
		font-size: 11px;
		color: var(--sig-text);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.mono {
		font-family: var(--font-mono);
	}

	:global(.meta-badge) {
		font-family: var(--font-mono) !important;
		font-size: 9px !important;
		padding: 0px 5px !important;
		height: auto !important;
		border-color: var(--sig-border-strong) !important;
		color: var(--sig-text-muted) !important;
	}

	.desc-text {
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.5;
		color: var(--sig-text);
		margin: 0;
	}

	/* Navigation */
	.nav-back {
		display: inline-flex;
		align-items: center;
		gap: 5px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-bright);
		border: none;
		background: none;
		cursor: pointer;
		padding: 4px 6px;
		border-radius: 4px;
		transition: background 80ms;
	}

	.nav-back:hover {
		background: var(--sig-surface-raised);
		color: var(--sig-highlight-text);
	}

	/* Breadcrumb */
	.breadcrumb {
		display: flex;
		align-items: center;
		gap: 4px;
		flex-wrap: wrap;
	}

	.breadcrumb-link {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-bright);
		border: none;
		background: none;
		cursor: pointer;
		padding: 2px 4px;
		border-radius: 3px;
		transition: background 80ms;
	}

	.breadcrumb-link:hover {
		background: var(--sig-surface-raised);
		color: var(--sig-highlight-text);
	}

	.breadcrumb-sep {
		font-size: 12px;
		color: var(--sig-text-muted);
	}

	/* Aspect cards (entity view) */
	.aspect-cards {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.aspect-card {
		border: 1px solid var(--sig-border);
		border-radius: 4px;
		padding: 6px 8px;
		background: var(--sig-bg);
	}

	.aspect-card-clickable {
		cursor: pointer;
		text-align: left;
		width: 100%;
		transition: border-color 120ms, background 80ms;
	}

	.aspect-card-clickable:hover {
		border-color: rgba(139, 92, 246, 0.4);
		background: rgba(139, 92, 246, 0.04);
	}

	.aspect-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 2px;
	}

	.aspect-name {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		color: var(--sig-text-bright);
	}

	.aspect-weight {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
	}

	.aspect-attr-count {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
	}

	/* Attribute cards (aspect view) */
	.attr-cards {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.attr-card {
		border: 1px solid var(--sig-border);
		border-radius: 4px;
		padding: 6px 8px;
		background: var(--sig-bg);
		cursor: pointer;
		text-align: left;
		width: 100%;
		transition: border-color 120ms, background 80ms;
	}

	.attr-card:hover {
		border-color: rgba(6, 182, 212, 0.4);
		background: rgba(6, 182, 212, 0.04);
	}

	.attr-card-selected {
		border-color: rgba(6, 182, 212, 0.6);
		background: rgba(6, 182, 212, 0.08);
	}

	.attr-card-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		margin-bottom: 3px;
	}

	:global(.attr-kind-badge) {
		font-family: var(--font-mono) !important;
		font-size: 8px !important;
		padding: 0px 4px !important;
		height: auto !important;
		border-color: var(--sig-border-strong) !important;
		color: var(--sig-text-muted) !important;
		flex-shrink: 0;
	}

	.attr-score {
		font-family: var(--font-mono);
		font-size: 8px;
		color: var(--sig-text-muted);
		white-space: nowrap;
	}

	.attr-card-content {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text);
		line-height: 1.4;
		margin: 0;
		display: -webkit-box;
		-webkit-line-clamp: 3;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.empty-hint {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		padding: 4px 0;
	}

	/* Dependencies */
	.dep-list {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.dep-row {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 3px 0;
	}

	.dep-direction {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-warning);
		width: 24px;
		flex-shrink: 0;
	}

	:global(.dep-type-badge) {
		font-family: var(--font-mono) !important;
		font-size: 8px !important;
		padding: 0px 4px !important;
		height: auto !important;
		border-color: rgba(212, 160, 23, 0.3) !important;
		color: var(--sig-warning) !important;
		flex-shrink: 0;
	}

	.dep-target {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-bright);
		flex: 1;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		border: none;
		background: none;
		cursor: pointer;
		text-align: left;
		padding: 0;
	}

	.dep-target:hover {
		color: var(--sig-highlight-text);
	}

	.dep-strength {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		flex-shrink: 0;
	}

	/* Empty state */
	.empty-state {
		display: flex;
		align-items: center;
		justify-content: center;
		height: 100px;
	}

	.empty-label {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.06em;
	}
</style>
