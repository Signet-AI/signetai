<script lang="ts">
import {
	type DatabaseSchemaGroup,
	type DatabaseSchemaResponse,
	type DatabaseTableInfo,
	type DatabaseTableSampleResponse,
	getDatabaseSchema,
	getDatabaseTableSample,
} from "$lib/api";
import { ScrollArea } from "$lib/components/ui/scroll-area/index.js";
import * as Table from "$lib/components/ui/table/index.js";
import ChevronLeft from "@lucide/svelte/icons/chevron-left";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import Database from "@lucide/svelte/icons/database";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";
import Search from "@lucide/svelte/icons/search";
import { onMount } from "svelte";

const GROUP_ORDER: readonly DatabaseSchemaGroup[] = ["core", "provenance", "runtime", "internal", "other"];
const GROUP_LABELS: Record<DatabaseSchemaGroup, string> = {
	core: "Core",
	provenance: "Provenance",
	runtime: "Runtime",
	internal: "Internal",
	other: "Other",
};
const PAGE_SIZE = 25;

let schema = $state<DatabaseSchemaResponse | null>(null);
let sample = $state<DatabaseTableSampleResponse | null>(null);
let selected = $state<string | null>(null);
// biome-ignore lint/style/useConst: bind:value mutates this Svelte state.
let query = $state("");
let loadingSchema = $state(false);
let loadingSample = $state(false);
let error = $state<string | null>(null);

const tables = $derived(schema?.tables ?? []);
const selectedTable = $derived(tables.find((table) => table.name === selected) ?? null);
const filteredTables = $derived.by(() => {
	const q = query.trim().toLowerCase();
	if (!q) return tables;
	return tables.filter((table) => table.name.toLowerCase().includes(q) || table.group.includes(q));
});
const visibleGroups = $derived(
	GROUP_ORDER.map((group) => ({
		group,
		tables: filteredTables.filter((table) => table.group === group),
	})).filter((entry) => entry.tables.length > 0),
);
const sampleColumns = $derived(
	sample?.columns.length ? sample.columns : (selectedTable?.columns.map((col) => col.name) ?? []),
);

function formatCount(count: number | null): string {
	if (count === null) return "unknown";
	return new Intl.NumberFormat().format(count);
}

function formatCell(value: unknown): string {
	if (value === null || value === undefined) return "";
	if (typeof value === "string") return value;
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return JSON.stringify(value);
}

async function loadSchema(): Promise<void> {
	loadingSchema = true;
	error = null;
	try {
		const next = await getDatabaseSchema();
		if (!next) {
			error = "Could not load database schema";
			schema = null;
			sample = null;
			selected = null;
			return;
		}
		schema = next;
		if (next.error) {
			error = next.error;
			sample = null;
			selected = null;
			return;
		}
		const current = selected ? next.tables.find((table) => table.name === selected) : null;
		const fallback = next.tables.find((table) => table.sampleAllowed) ?? next.tables[0] ?? null;
		await selectTable(current?.name ?? fallback?.name ?? null, 0);
	} finally {
		loadingSchema = false;
	}
}

async function selectTable(name: string | null, offset = 0): Promise<void> {
	selected = name;
	sample = null;
	if (!name) return;
	const table = tables.find((entry) => entry.name === name);
	if (!table?.sampleAllowed) return;
	loadingSample = true;
	try {
		sample = await getDatabaseTableSample(name, { limit: PAGE_SIZE, offset });
	} finally {
		loadingSample = false;
	}
}

function previousPage(): void {
	if (!selected || !sample) return;
	void selectTable(selected, Math.max(0, sample.offset - sample.limit));
}

function nextPage(): void {
	if (!selected || !sample?.hasMore) return;
	void selectTable(selected, sample.offset + sample.limit);
}

onMount(() => {
	void loadSchema();
});
</script>

<div class="db-panel">
	<aside class="table-list">
		<header class="list-header">
			<div class="header-title">
				<span class="header-icon"><Database /></span>
				<span>Database</span>
			</div>
			<button class="icon-btn" type="button" title="Refresh schema" onclick={() => void loadSchema()}>
				<span class:spin={loadingSchema}><RefreshCw /></span>
			</button>
		</header>
		<div class="search-row">
			<Search />
			<input bind:value={query} placeholder="Search tables" aria-label="Search database tables" />
		</div>
		<ScrollArea class="flex-1 min-h-0">
			{#if loadingSchema && !schema}
				<div class="state-text">Loading schema...</div>
			{:else if error}
				<div class="state-text error">{error}</div>
			{:else if visibleGroups.length === 0}
				<div class="state-text">No tables matched</div>
			{:else}
				{#each visibleGroups as entry (entry.group)}
					<section class="group-block">
						<div class="group-label">
							<span>{GROUP_LABELS[entry.group]}</span>
							<span>{schema?.groups[entry.group] ?? entry.tables.length}</span>
						</div>
						{#each entry.tables as table (table.name)}
							<button
								type="button"
								class="table-row"
								class:active={selected === table.name}
								onclick={() => void selectTable(table.name)}
							>
								<span class="table-name">{table.name}</span>
								<span class="row-count">{formatCount(table.rowCount)}</span>
							</button>
						{/each}
					</section>
				{/each}
			{/if}
		</ScrollArea>
	</aside>

	<section class="detail-pane">
		{#if selectedTable}
			<header class="detail-header">
				<div>
					<div class="detail-kicker">{selectedTable.group} / {selectedTable.kind}</div>
					<h2>{selectedTable.name}</h2>
				</div>
				<div class="detail-stats">
					<span>{formatCount(selectedTable.rowCount)} rows</span>
					<span>{selectedTable.columns.length} columns</span>
					<span>{selectedTable.indexes.length} indexes</span>
				</div>
			</header>

			<div class="metadata-grid">
				<section class="metadata-section">
					<div class="section-title">Columns</div>
					<div class="column-list">
						{#each selectedTable.columns as column (column.name)}
							<div class="column-row">
								<span class="column-name">{column.name}</span>
								<span class="column-type">{column.type || "untyped"}</span>
								{#if column.primaryKey}<span class="tag">pk</span>{/if}
								{#if column.notNull}<span class="tag">not null</span>{/if}
							</div>
						{/each}
					</div>
				</section>

				<section class="metadata-section">
					<div class="section-title">Indexes</div>
					{#if selectedTable.indexes.length === 0}
						<div class="muted">No indexes reported</div>
					{:else}
						<div class="index-list">
							{#each selectedTable.indexes as index (index.name)}
								<div class="index-row">
									<span class="index-name">{index.name}</span>
									<span class="index-cols">{index.columns.map((col) => col.name).join(", ") || "expression"}</span>
									{#if index.unique}<span class="tag">unique</span>{/if}
								</div>
							{/each}
						</div>
					{/if}
				</section>

				<section class="metadata-section">
					<div class="section-title">Foreign Keys</div>
					{#if selectedTable.foreignKeys.length === 0}
						<div class="muted">No foreign keys reported</div>
					{:else}
						<div class="index-list">
							{#each selectedTable.foreignKeys as fk (`${fk.id}-${fk.seq}-${fk.from}`)}
								<div class="index-row">
									<span class="index-name">{fk.from}</span>
									<span class="index-cols">{fk.table}.{fk.to}</span>
								</div>
							{/each}
						</div>
					{/if}
				</section>
			</div>

			<section class="sample-section">
				<div class="sample-header">
					<div>
						<div class="section-title">Sample Rows</div>
						{#if selectedTable.sampleBlockedReason}
							<div class="muted">Unavailable: {selectedTable.sampleBlockedReason}</div>
						{:else if sample?.error}
							<div class="muted error">{sample.error}</div>
						{:else}
							<div class="muted">Read-only, capped at {PAGE_SIZE} rows per page</div>
						{/if}
					</div>
					{#if selectedTable.sampleAllowed && sample}
						<div class="pager">
							<button type="button" class="icon-btn" onclick={previousPage} disabled={sample.offset === 0}>
								<ChevronLeft />
							</button>
							<span>{sample.offset + 1}-{sample.offset + sample.rows.length}</span>
							<button type="button" class="icon-btn" onclick={nextPage} disabled={!sample.hasMore}>
								<ChevronRight />
							</button>
						</div>
					{/if}
				</div>

				<div class="sample-table-wrap">
					{#if loadingSample}
						<div class="state-text">Loading rows...</div>
					{:else if !selectedTable.sampleAllowed}
						<div class="state-text">Samples are disabled for this table.</div>
					{:else if sampleColumns.length === 0}
						<div class="state-text">No sample columns available.</div>
					{:else}
						<Table.Root>
							<Table.Header>
								<Table.Row>
									{#each sampleColumns as column (column)}
										<Table.Head>{column}</Table.Head>
									{/each}
								</Table.Row>
							</Table.Header>
							<Table.Body>
								{#if sample?.rows.length}
									{#each sample.rows as row, index (`${selectedTable.name}-${sample.offset}-${index}`)}
										<Table.Row>
											{#each sampleColumns as column (column)}
												<Table.Cell title={formatCell(row[column])}>{formatCell(row[column])}</Table.Cell>
											{/each}
										</Table.Row>
									{/each}
								{:else}
									<Table.Row>
										<Table.Cell colspan={sampleColumns.length}>No rows in this window.</Table.Cell>
									</Table.Row>
								{/if}
							</Table.Body>
						</Table.Root>
					{/if}
				</div>
			</section>
		{:else}
			<div class="state-text">Select a table to inspect schema and sample rows.</div>
		{/if}
	</section>
</div>

<style>
	.db-panel {
		display: grid;
		grid-template-columns: minmax(220px, 280px) minmax(0, 1fr);
		flex: 1;
		min-height: 0;
		background: var(--sig-bg);
	}

	.table-list {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border-right: 1px solid var(--sig-border);
		background: var(--sig-surface);
	}

	.list-header,
	.detail-header,
	.sample-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 12px;
	}

	.list-header {
		padding: 10px 12px;
		border-bottom: 1px solid var(--sig-border);
	}

	.header-title,
	.detail-kicker,
	.section-title,
	.group-label,
	.row-count,
	.tag,
	.muted,
	.pager {
		font-family: var(--font-body);
	}

	.header-title {
		display: flex;
		align-items: center;
		gap: 7px;
		font-size: 10px;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.header-icon :global(svg),
	.search-row :global(svg),
	.icon-btn :global(svg) {
		width: 14px;
		height: 14px;
	}

	.icon-btn {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		width: 28px;
		height: 28px;
		border: 1px solid var(--sig-border);
		background: var(--sig-bg);
		color: var(--sig-text-muted);
		cursor: pointer;
	}

	.icon-btn:hover:not(:disabled) {
		color: var(--sig-highlight);
		border-color: var(--sig-highlight);
	}

	.icon-btn:disabled {
		cursor: not-allowed;
		opacity: 0.35;
	}

	.spin {
		animation: spin 900ms linear infinite;
	}

	.search-row {
		display: flex;
		align-items: center;
		gap: 7px;
		margin: 10px 12px;
		padding: 0 8px;
		height: 30px;
		border: 1px solid var(--sig-border);
		background: var(--sig-bg);
		color: var(--sig-text-muted);
	}

	.search-row input {
		min-width: 0;
		flex: 1;
		border: 0;
		outline: 0;
		background: transparent;
		color: var(--sig-text);
		font-family: var(--font-body);
		font-size: 11px;
	}

	.group-block {
		padding: 4px 0 8px;
	}

	.group-label {
		display: flex;
		justify-content: space-between;
		padding: 5px 12px;
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.09em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
	}

	.table-row {
		display: grid;
		grid-template-columns: minmax(0, 1fr) auto;
		gap: 8px;
		width: 100%;
		padding: 5px 12px;
		border: 0;
		background: transparent;
		color: var(--sig-text);
		cursor: pointer;
		text-align: left;
	}

	.table-row:hover,
	.table-row.active {
		background: var(--sig-surface-raised);
	}

	.table-row.active {
		color: var(--sig-highlight);
		box-shadow: inset 2px 0 0 var(--sig-highlight);
	}

	.table-name {
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 11px;
	}

	.row-count {
		font-size: 9px;
		color: var(--sig-text-muted);
	}

	.detail-pane {
		display: flex;
		flex-direction: column;
		min-width: 0;
		min-height: 0;
		overflow: hidden;
	}

	.detail-header {
		padding: 14px 16px;
		border-bottom: 1px solid var(--sig-border);
	}

	.detail-kicker {
		margin-bottom: 3px;
		font-size: 9px;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-muted);
	}

	h2 {
		margin: 0;
		font-family: var(--font-display);
		font-size: 18px;
		color: var(--sig-text-bright);
	}

	.detail-stats {
		display: flex;
		flex-wrap: wrap;
		justify-content: flex-end;
		gap: 6px;
		font-family: var(--font-body);
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	.detail-stats span,
	.tag {
		border: 1px solid var(--sig-border);
		padding: 2px 6px;
		background: var(--sig-bg);
	}

	.metadata-grid {
		display: grid;
		grid-template-columns: repeat(3, minmax(0, 1fr));
		gap: 1px;
		border-bottom: 1px solid var(--sig-border);
		background: var(--sig-border);
	}

	.metadata-section {
		min-width: 0;
		padding: 12px;
		background: var(--sig-bg);
	}

	.section-title {
		margin-bottom: 8px;
		font-size: 9px;
		font-weight: 700;
		letter-spacing: 0.1em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.column-list,
	.index-list {
		display: flex;
		flex-direction: column;
		gap: 5px;
		max-height: 150px;
		overflow: auto;
	}

	.column-row,
	.index-row {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		font-family: var(--font-body);
		font-size: 10px;
		color: var(--sig-text);
	}

	.column-name,
	.index-name {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		color: var(--sig-text-bright);
	}

	.column-type,
	.index-cols {
		min-width: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		color: var(--sig-text-muted);
	}

	.tag {
		flex-shrink: 0;
		font-size: 8px;
		line-height: 1.2;
		text-transform: uppercase;
		color: var(--sig-text-muted);
	}

	.muted,
	.state-text {
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	.error {
		color: var(--sig-danger);
	}

	.sample-section {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		padding: 12px 16px 16px;
	}

	.sample-header {
		flex-shrink: 0;
		margin-bottom: 10px;
	}

	.pager {
		display: flex;
		align-items: center;
		gap: 8px;
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	.sample-table-wrap {
		flex: 1;
		min-height: 0;
		overflow: auto;
		border: 1px solid var(--sig-border);
		background: var(--sig-surface);
	}

	.sample-table-wrap :global(table) {
		min-width: 760px;
	}

	.sample-table-wrap :global(th),
	.sample-table-wrap :global(td) {
		max-width: 320px;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
		font-family: var(--font-mono);
		font-size: 10px;
	}

	.state-text {
		padding: 16px;
	}

	@media (max-width: 860px) {
		.db-panel {
			grid-template-columns: 1fr;
		}

		.table-list {
			max-height: 260px;
			border-right: 0;
			border-bottom: 1px solid var(--sig-border);
		}

		.metadata-grid {
			grid-template-columns: 1fr;
		}
	}

	@keyframes spin {
		to {
			transform: rotate(360deg);
		}
	}
</style>
