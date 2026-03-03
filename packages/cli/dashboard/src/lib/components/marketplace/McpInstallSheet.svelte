<script lang="ts">
import type { MarketplaceMcpCatalogEntry, MarketplaceMcpConfig } from "$lib/api";
import { getMarketplaceMcpDetail, getSecrets, testMarketplaceMcpConfig } from "$lib/api";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { Label } from "$lib/components/ui/label/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import * as Sheet from "$lib/components/ui/sheet/index.js";
import { Textarea } from "$lib/components/ui/textarea/index.js";
import { installMarketplaceCatalogServer } from "$lib/stores/marketplace-mcp.svelte";

interface Props {
	open: boolean;
	entry: MarketplaceMcpCatalogEntry | null;
	onclose: () => void;
}

interface KeyValueRow {
	key: string;
	value: string;
	secretName: string;
}

const SECRET_REF_PREFIX = "secret://";

const { open, entry, onclose }: Props = $props();

let loadingDetail = $state(false);
let detailError = $state<string | null>(null);
let loadKey = $state<string>("");

let detailDescription = $state("");
let githubUrl = $state("");
let hasRecommendedConfig = $state(false);

let alias = $state("");
let transport = $state<"stdio" | "http">("stdio");
let timeoutMs = $state("20000");

let command = $state("");
let argsText = $state("");
let cwd = $state("");
let envRows = $state<KeyValueRow[]>([]);

let url = $state("");
let headerRows = $state<KeyValueRow[]>([]);

let secrets = $state<string[]>([]);
let loadingSecrets = $state(false);

let testState = $state<"idle" | "running" | "success" | "error">("idle");
let testMessage = $state("");
let testTools = $state<string[]>([]);
let installing = $state(false);
let formError = $state<string | null>(null);
const activeTransportLabel = $derived(transport === "http" ? "http" : "stdio");

const serverSourceLabel = $derived.by(() => {
	if (!entry) return "";
	return entry.source === "modelcontextprotocol/servers" ? "MCP GitHub" : "MCP Registry";
});

$effect(() => {
	if (!open || !entry) return;
	if (loadKey === entry.id) return;
	loadKey = entry.id;
	void loadEntryConfig(entry);
});

$effect(() => {
	if (open) return;
	loadKey = "";
	loadingDetail = false;
	detailError = null;
	testState = "idle";
	testMessage = "";
	testTools = [];
	formError = null;
});

function parseSecretReference(value: string): string {
	if (!value.startsWith(SECRET_REF_PREFIX)) {
		return "";
	}
	return value.slice(SECRET_REF_PREFIX.length).trim();
}

function decodeRow(key: string, value: string): KeyValueRow {
	const secretName = parseSecretReference(value);
	if (secretName) {
		return { key, value: "", secretName };
	}
	return { key, value, secretName: "" };
}

function encodeValue(row: KeyValueRow): string {
	if (row.secretName.trim().length > 0) {
		return `${SECRET_REF_PREFIX}${row.secretName.trim()}`;
	}
	return row.value;
}

function rowsFromRecord(values: Readonly<Record<string, string>>): KeyValueRow[] {
	const entries = Object.entries(values).map(([key, value]) => decodeRow(key, value));
	return entries.length > 0 ? entries : [{ key: "", value: "", secretName: "" }];
}

function applyConfig(config: MarketplaceMcpConfig): void {
	transport = config.transport;
	timeoutMs = String(config.timeoutMs);

	if (config.transport === "stdio") {
		command = config.command;
		argsText = config.args.join("\n");
		cwd = config.cwd ?? "";
		envRows = rowsFromRecord(config.env);
		url = "";
		headerRows = [{ key: "", value: "", secretName: "" }];
		return;
	}

	url = config.url;
	headerRows = rowsFromRecord(config.headers);
	command = "";
	argsText = "";
	cwd = "";
	envRows = [{ key: "", value: "", secretName: "" }];
}

async function loadEntryConfig(nextEntry: MarketplaceMcpCatalogEntry): Promise<void> {
	loadingDetail = true;
	detailError = null;
	formError = null;
	testState = "idle";
	testMessage = "";
	testTools = [];

	alias = nextEntry.name;
	detailDescription = nextEntry.description;
	githubUrl = "";
	hasRecommendedConfig = false;
	transport = "stdio";
	timeoutMs = "20000";
	command = "";
	argsText = "";
	cwd = "";
	envRows = [{ key: "", value: "", secretName: "" }];
	url = "";
	headerRows = [{ key: "", value: "", secretName: "" }];

	loadingSecrets = true;
	const [detail, secretNames] = await Promise.all([
		getMarketplaceMcpDetail(nextEntry.catalogId, nextEntry.source),
		getSecrets(),
	]);
	secrets = secretNames;
	loadingSecrets = false;

	if (!detail) {
		detailError = "Failed to load recommended config for this server.";
		loadingDetail = false;
		return;
	}

	detailDescription = detail.description || nextEntry.description;
	githubUrl = detail.githubUrl ?? "";

	if (detail.defaultConfig) {
		hasRecommendedConfig = true;
		applyConfig(detail.defaultConfig);
	} else {
		detailError = "No standard config was found. You can still set one manually below.";
	}

	loadingDetail = false;
}

function parseRows(rows: readonly KeyValueRow[]): Record<string, string> {
	const out: Record<string, string> = {};
	for (const row of rows) {
		const key = row.key.trim();
		if (key.length === 0) continue;
		const encoded = encodeValue(row).trim();
		if (encoded.length === 0) continue;
		out[key] = encoded;
	}
	return out;
}

function buildConfig(): { config: MarketplaceMcpConfig | null; error?: string } {
	const parsedTimeout = Number(timeoutMs);
	if (!Number.isFinite(parsedTimeout) || parsedTimeout <= 0) {
		return { config: null, error: "Timeout must be a positive number." };
	}

	if (transport === "stdio") {
		const nextCommand = command.trim();
		if (nextCommand.length === 0) {
			return { config: null, error: "Command is required for stdio transport." };
		}
		const args = argsText
			.split("\n")
			.map((item) => item.trim())
			.filter((item) => item.length > 0);
		return {
			config: {
				transport: "stdio",
				command: nextCommand,
				args,
				env: parseRows(envRows),
				cwd: cwd.trim() || undefined,
				timeoutMs: parsedTimeout,
			},
		};
	}

	const nextUrl = url.trim();
	if (nextUrl.length === 0) {
		return { config: null, error: "URL is required for HTTP transport." };
	}
	try {
		new URL(nextUrl);
	} catch {
		return { config: null, error: "URL must be a valid absolute URL." };
	}

	return {
		config: {
			transport: "http",
			url: nextUrl,
			headers: parseRows(headerRows),
			timeoutMs: parsedTimeout,
		},
	};
}

function parseTransport(value: string): "stdio" | "http" {
	return value === "http" ? "http" : "stdio";
}

function updateRowValue(rows: KeyValueRow[], index: number, value: string): void {
	const row = rows[index];
	if (!row) return;
	row.value = value;
	if (value.trim().length > 0) {
		row.secretName = "";
	}
}

function addEnvRow(): void {
	envRows = [...envRows, { key: "", value: "", secretName: "" }];
}

function removeEnvRow(index: number): void {
	envRows = envRows.filter((_row, rowIndex) => rowIndex !== index);
	if (envRows.length === 0) {
		envRows = [{ key: "", value: "", secretName: "" }];
	}
}

function addHeaderRow(): void {
	headerRows = [...headerRows, { key: "", value: "", secretName: "" }];
}

function removeHeaderRow(index: number): void {
	headerRows = headerRows.filter((_row, rowIndex) => rowIndex !== index);
	if (headerRows.length === 0) {
		headerRows = [{ key: "", value: "", secretName: "" }];
	}
}

async function runConfigTest(): Promise<void> {
	formError = null;
	testState = "running";
	testMessage = "Testing MCP server connection...";
	testTools = [];

	const built = buildConfig();
	if (!built.config) {
		testState = "error";
		testMessage = built.error ?? "Invalid config.";
		formError = built.error ?? "Invalid config.";
		return;
	}

	const result = await testMarketplaceMcpConfig({ config: built.config });
	if (result.success) {
		testState = "success";
		testTools = result.tools ?? [];
		testMessage = `Connection succeeded${typeof result.toolCount === "number" ? ` (${result.toolCount} tools)` : ""}.`;
		return;
	}

	testState = "error";
	testMessage = result.error ?? "Connection test failed.";
}

async function installWithConfig(): Promise<void> {
	if (!entry) return;
	formError = null;

	const built = buildConfig();
	if (!built.config) {
		formError = built.error ?? "Invalid config.";
		return;
	}

	installing = true;
	const success = await installMarketplaceCatalogServer(entry, {
		alias: alias.trim() || undefined,
		config: built.config,
	});
	installing = false;

	if (success) {
		onclose();
	}
}
</script>

<Sheet.Root {open} onOpenChange={(v) => { if (!v) onclose(); }}>
	<Sheet.Content
		side="right"
		class="!w-[560px] !max-w-[96vw] !bg-[var(--sig-surface)]
			!border-l !border-l-[var(--sig-border)] !p-0 flex flex-col"
	>
		<div class="sheet-header">
			<div>
				<h2 class="sheet-title">Install Tool Server</h2>
				{#if entry}
					<p class="sheet-subtitle">{entry.name} · {serverSourceLabel}</p>
				{/if}
			</div>
		</div>

		<div class="sheet-body">
			{#if !entry}
				<p class="muted">Select a server to configure.</p>
			{:else}
				{#if loadingDetail}
					<p class="muted">Loading recommended configuration...</p>
				{:else}
					<p class="server-description">{detailDescription}</p>
					{#if githubUrl}
						<a class="source-link" href={githubUrl} target="_blank" rel="noopener">View source README</a>
					{/if}
					{#if detailError}
						<div class="inline-alert">{detailError}</div>
					{/if}

					<div class="config-card">
						<div class="field-group">
							<Label class="field-label">Install alias</Label>
							<Input
								value={alias}
								oninput={(e) => {
									alias = e.currentTarget.value;
								}}
								placeholder="Server name"
								class="field-input"
							/>
						</div>

						<div class="field-row two-col">
							<div class="field-group">
								<Label class="field-label">Transport</Label>
								<Select.Root
									type="single"
									value={transport}
									onValueChange={(v) => {
										transport = parseTransport(v ?? "stdio");
									}}
								>
									<Select.Trigger class="field-select">{activeTransportLabel}</Select.Trigger>
									<Select.Content class="field-select-content">
										<Select.Item value="stdio" label="stdio" class="field-select-item" />
										<Select.Item value="http" label="http" class="field-select-item" />
									</Select.Content>
								</Select.Root>
							</div>
							<div class="field-group">
								<Label class="field-label">Timeout (ms)</Label>
								<Input
									type="number"
									value={timeoutMs}
									oninput={(e) => {
										timeoutMs = e.currentTarget.value;
									}}
									class="field-input font-[family-name:var(--font-mono)]"
								/>
							</div>
						</div>

						{#if transport === "stdio"}
							<div class="field-group">
								<Label class="field-label">Command</Label>
								<Input
									value={command}
									oninput={(e) => {
										command = e.currentTarget.value;
									}}
									placeholder="uvx"
									class="field-input font-[family-name:var(--font-mono)]"
								/>
							</div>
							<div class="field-group">
								<Label class="field-label">Args (one per line)</Label>
								<Textarea
									value={argsText}
									oninput={(e) => {
										argsText = e.currentTarget.value;
									}}
									rows={3}
									class="field-textarea font-[family-name:var(--font-mono)]"
								/>
							</div>
							<div class="field-group">
								<Label class="field-label">Working directory (optional)</Label>
								<Input
									value={cwd}
									oninput={(e) => {
										cwd = e.currentTarget.value;
									}}
									placeholder="/path/to/project"
									class="field-input font-[family-name:var(--font-mono)]"
								/>
							</div>

							<div class="field-group">
								<div class="row-head">
									<Label class="field-label">Environment variables</Label>
									<Button variant="outline" size="sm" class="h-6 text-[9px]" onclick={addEnvRow}>Add</Button>
								</div>
								<div class="row-list">
									{#each envRows as row, index (index)}
										<div class="row-item">
											<Input
												value={row.key}
												oninput={(e) => {
													row.key = e.currentTarget.value;
												}}
												placeholder="ENV_NAME"
												class="field-input row-key font-[family-name:var(--font-mono)]"
											/>
											<Input
												value={row.value}
												oninput={(e) => {
													updateRowValue(envRows, index, e.currentTarget.value);
												}}
												placeholder="value"
												class="field-input row-value font-[family-name:var(--font-mono)]"
												disabled={row.secretName.length > 0}
											/>
											<select
												class="field-select row-secret"
												value={row.secretName}
												onchange={(e) => {
													row.secretName = e.currentTarget.value;
													if (row.secretName.length > 0) {
														row.value = "";
													}
												}}
												disabled={loadingSecrets || secrets.length === 0}
											>
												<option value="">Plain value</option>
												{#each secrets as secretName (secretName)}
													<option value={secretName}>secret:{secretName}</option>
												{/each}
											</select>
											<Button variant="outline" size="sm" class="h-8 px-2" onclick={() => removeEnvRow(index)}>×</Button>
										</div>
									{/each}
								</div>
								{#if secrets.length === 0}
									<div class="inline-hint">No secrets found. Add secrets in the Secrets tab to map sensitive values.</div>
								{/if}
							</div>
						{:else}
							<div class="field-group">
								<Label class="field-label">Server URL</Label>
								<Input
									value={url}
									oninput={(e) => {
										url = e.currentTarget.value;
									}}
									placeholder="https://example.com/mcp"
									class="field-input font-[family-name:var(--font-mono)]"
								/>
							</div>
							<div class="field-group">
								<div class="row-head">
									<Label class="field-label">HTTP headers</Label>
									<Button variant="outline" size="sm" class="h-6 text-[9px]" onclick={addHeaderRow}>Add</Button>
								</div>
								<div class="row-list">
									{#each headerRows as row, index (index)}
										<div class="row-item">
											<Input
												value={row.key}
												oninput={(e) => {
													row.key = e.currentTarget.value;
												}}
												placeholder="Authorization"
												class="field-input row-key font-[family-name:var(--font-mono)]"
											/>
											<Input
												value={row.value}
												oninput={(e) => {
													updateRowValue(headerRows, index, e.currentTarget.value);
												}}
												placeholder="Bearer ..."
												class="field-input row-value font-[family-name:var(--font-mono)]"
												disabled={row.secretName.length > 0}
											/>
											<select
												class="field-select row-secret"
												value={row.secretName}
												onchange={(e) => {
													row.secretName = e.currentTarget.value;
													if (row.secretName.length > 0) {
														row.value = "";
													}
												}}
												disabled={loadingSecrets || secrets.length === 0}
											>
												<option value="">Plain value</option>
												{#each secrets as secretName (secretName)}
													<option value={secretName}>secret:{secretName}</option>
												{/each}
											</select>
											<Button variant="outline" size="sm" class="h-8 px-2" onclick={() => removeHeaderRow(index)}>×</Button>
										</div>
									{/each}
								</div>
							</div>
						{/if}
					</div>

					{#if formError}
						<div class="inline-alert">{formError}</div>
					{/if}

					<div class="test-panel" data-state={testState}>
						<div class="test-head">Connection test</div>
						<p class="test-message">{testMessage || "Run a test before installing to confirm this config works."}</p>
						{#if testTools.length > 0}
							<div class="test-tools">{testTools.join(", ")}</div>
						{/if}
					</div>
				{/if}
			{/if}
		</div>

		<div class="sheet-footer">
			<div class="footer-hint">
				{#if hasRecommendedConfig}
					Using recommended config as a starting point.
				{:else}
					No recommended config found; set command/URL manually.
				{/if}
			</div>
			<div class="footer-actions">
				<Button
					variant="outline"
					size="sm"
					class="h-8 text-[10px]"
					onclick={() => void runConfigTest()}
					disabled={loadingDetail || testState === "running" || installing || !entry}
				>
					{testState === "running" ? "Testing..." : "Test connection"}
				</Button>
				<Button
					variant="default"
					size="sm"
					class="h-8 text-[10px]"
					onclick={() => void installWithConfig()}
					disabled={loadingDetail || installing || !entry}
				>
					{installing ? "Installing..." : "Install server"}
				</Button>
			</div>
		</div>
	</Sheet.Content>
</Sheet.Root>

<style>
	.sheet-header {
		padding: 14px 16px;
		border-bottom: 1px solid var(--sig-border);
	}

	.sheet-title {
		margin: 0;
		font-family: var(--font-display);
		font-size: 14px;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		color: var(--sig-text-bright);
	}

	.sheet-subtitle {
		margin: 4px 0 0;
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
	}

	.sheet-body {
		flex: 1;
		overflow-y: auto;
		padding: 12px 16px;
		display: flex;
		flex-direction: column;
		gap: 10px;
	}

	.muted {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text-muted);
	}

	.server-description {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.55;
		color: var(--sig-text);
	}

	.source-link {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-accent);
		text-decoration: none;
	}

	.source-link:hover {
		text-decoration: underline;
	}

	.config-card {
		display: flex;
		flex-direction: column;
		gap: 10px;
		padding: 10px;
		border: 1px solid var(--sig-border);
		background: var(--sig-surface-raised);
	}

	.field-row.two-col {
		display: grid;
		grid-template-columns: repeat(2, minmax(0, 1fr));
		gap: 8px;
	}

	.field-group {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	:global(.field-label) {
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
		font-family: var(--font-mono);
	}

	:global(.field-input),
	:global(.field-select),
	:global(.field-textarea) {
		background: var(--sig-surface);
		border: 1px solid var(--sig-border-strong);
		color: var(--sig-text-bright);
		font-size: 11px;
	}

	:global(.field-select) {
		height: 32px;
		padding: 0 8px;
		border-radius: 0.5rem;
	}

	:global(.field-select-content) {
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		border-radius: 0.5rem;
	}

	:global(.field-select-item) {
		font-family: var(--font-mono);
		font-size: 10px;
	}

	:global(.field-textarea) {
		resize: vertical;
		min-height: 70px;
	}

	.row-head {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 8px;
	}

	.row-list {
		display: flex;
		flex-direction: column;
		gap: 6px;
	}

	.row-item {
		display: grid;
		grid-template-columns: minmax(0, 1fr) minmax(0, 1.3fr) minmax(0, 1.2fr) auto;
		gap: 6px;
		align-items: center;
	}

	.inline-hint {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	.inline-alert {
		padding: 8px 10px;
		border: 1px solid color-mix(in srgb, var(--sig-danger) 35%, var(--sig-border));
		background: color-mix(in srgb, var(--sig-danger) 10%, transparent);
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-danger);
	}

	.test-panel {
		border: 1px solid var(--sig-border);
		padding: 8px 10px;
		display: flex;
		flex-direction: column;
		gap: 5px;
		background: var(--sig-surface-raised);
	}

	.test-panel[data-state="success"] {
		border-color: color-mix(in srgb, var(--sig-success) 45%, var(--sig-border));
	}

	.test-panel[data-state="error"] {
		border-color: color-mix(in srgb, var(--sig-danger) 45%, var(--sig-border));
	}

	.test-head {
		font-family: var(--font-mono);
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
	}

	.test-message,
	.test-tools {
		margin: 0;
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.45;
		color: var(--sig-text);
	}

	.sheet-footer {
		padding: 10px 16px;
		border-top: 1px solid var(--sig-border);
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 10px;
	}

	.footer-hint {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
	}

	.footer-actions {
		display: flex;
		align-items: center;
		gap: 8px;
	}

	@media (max-width: 820px) {
		.row-item {
			grid-template-columns: 1fr;
		}

		.sheet-footer {
			flex-direction: column;
			align-items: stretch;
		}

		.footer-actions {
			justify-content: flex-end;
		}
	}
</style>
