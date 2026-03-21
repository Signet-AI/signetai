<script lang="ts">
	import { API_BASE } from "$lib/api";
	import * as Select from "$lib/components/ui/select/index.js";
	import Trash2 from "@lucide/svelte/icons/trash-2";
	import Loader from "@lucide/svelte/icons/loader";
	import Activity from "@lucide/svelte/icons/activity";
	import Wrench from "@lucide/svelte/icons/wrench";
	import Info from "@lucide/svelte/icons/info";
	import Terminal from "@lucide/svelte/icons/terminal";
	import ChevronDown from "@lucide/svelte/icons/chevron-down";
	import { tick } from "svelte";

	type CmdKind = "cli" | "api";

	interface CommandDef {
		readonly label: string;
		readonly kind: CmdKind;
		readonly key?: string;
		readonly method?: "GET" | "POST";
		readonly path?: string;
		readonly danger?: boolean;
	}

	interface GroupDef {
		readonly id: string;
		readonly title: string;
		readonly icon: typeof Activity;
		readonly color: string;
		readonly commands: readonly CommandDef[];
	}

	const groupDefs: readonly GroupDef[] = [
		{
			id: "cli",
			title: "CLI",
			icon: Terminal,
			color: "var(--sig-highlight)",
			commands: [
				{ label: "Status", kind: "cli", key: "status" },
				{ label: "Daemon Status", kind: "cli", key: "daemon-status" },
				{ label: "Daemon Logs", kind: "cli", key: "daemon-logs" },
				{ label: "Sync", kind: "cli", key: "sync" },
				{ label: "Embed Audit", kind: "cli", key: "embed-audit" },
				{ label: "Skill List", kind: "cli", key: "skill-list" },
				{ label: "Secret List", kind: "cli", key: "secret-list" },
				{ label: "Recall Test", kind: "cli", key: "recall-test" },
			],
		},
		{
			id: "status",
			title: "Status",
			icon: Activity,
			color: "var(--sig-highlight)",
			commands: [
				{ label: "Health", kind: "api", method: "GET", path: "/health" },
				{ label: "Diagnostics", kind: "api", method: "GET", path: "/api/diagnostics" },
				{ label: "Pipeline", kind: "api", method: "GET", path: "/api/pipeline/status" },
				{ label: "Predictor", kind: "api", method: "GET", path: "/api/predictor/status" },
				{ label: "Git", kind: "api", method: "GET", path: "/api/git/status" },
				{ label: "Embeddings", kind: "api", method: "GET", path: "/api/embeddings/health" },
			],
		},
		{
			id: "info",
			title: "Info",
			icon: Info,
			color: "var(--sig-highlight)",
			commands: [
				{ label: "Embed Gaps", kind: "api", method: "GET", path: "/api/repair/embedding-gaps" },
				{ label: "Dedup Stats", kind: "api", method: "GET", path: "/api/repair/dedup-stats" },
				{ label: "Cold Stats", kind: "api", method: "GET", path: "/api/repair/cold-stats" },
			],
		},
		{
			id: "repair",
			title: "Repair",
			icon: Wrench,
			color: "var(--sig-highlight)",
			commands: [
				{ label: "Check FTS", kind: "api", method: "POST", path: "/api/repair/check-fts" },
				{ label: "Re-embed", kind: "api", method: "POST", path: "/api/repair/re-embed" },
				{ label: "Resync Vec", kind: "api", method: "POST", path: "/api/repair/resync-vec" },
				{ label: "Clean Orphans", kind: "api", method: "POST", path: "/api/repair/clean-orphans" },
				{ label: "Deduplicate", kind: "api", method: "POST", path: "/api/repair/deduplicate" },
				{ label: "Retention", kind: "api", method: "POST", path: "/api/repair/retention-sweep" },
				{ label: "Requeue Dead", kind: "api", method: "POST", path: "/api/repair/requeue-dead" },
				{ label: "Release Leases", kind: "api", method: "POST", path: "/api/repair/release-leases" },
				{ label: "Backfill Skipped", kind: "api", method: "POST", path: "/api/repair/backfill-skipped" },
				{ label: "Reclassify", kind: "api", method: "POST", path: "/api/repair/reclassify-entities" },
				{ label: "Prune Chunks", kind: "api", method: "POST", path: "/api/repair/prune-chunk-groups" },
				{ label: "Prune Singletons", kind: "api", method: "POST", path: "/api/repair/prune-singleton-entities" },
				{ label: "Stop Daemon", kind: "cli", key: "daemon-stop" },
				{ label: "Restart Daemon", kind: "cli", key: "daemon-restart" },
				{ label: "Update Signet", kind: "cli", key: "update" },
			],
		},
	];

	// Per-group state
	interface GroupState {
		lines: string[];
		running: boolean;
		expanded: boolean;
		selected: number;
	}

	let panels = $state<Record<string, GroupState>>(
		Object.fromEntries(groupDefs.map(g => [g.id, { lines: [], running: false, expanded: true, selected: 0 }]))
	);

	const termRefs: Record<string, HTMLDivElement | undefined> = {};

	function bindTerm(el: HTMLDivElement, id: string): void {
		termRefs[id] = el;
	}

	async function scrollGroup(id: string): Promise<void> {
		await tick();
		const el = termRefs[id];
		el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
	}

	function appendLine(id: string, text: string): void {
		const gs = panels[id];
		if (!gs) return;
		gs.lines = [...gs.lines, text];
	}

	function clearGroup(id: string): void {
		const gs = panels[id];
		if (gs) gs.lines = [];
	}

	function toggleGroup(id: string): void {
		const gs = panels[id];
		if (gs) gs.expanded = !gs.expanded;
	}

	async function execCli(gid: string, cmd: CommandDef): Promise<void> {
		const gs = panels[gid];
		if (!gs || gs.running || !cmd.key) return;
		gs.running = true;
		gs.expanded = true;

		appendLine(gid, `\x1b[32m$\x1b[0m signet ${cmd.key.replace(/-/g, " ")}`);
		await scrollGroup(gid);

		const abort = new AbortController();
		let initiated = false;
		try {
			const res = await fetch(`${API_BASE}/api/troubleshoot/exec`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ key: cmd.key }),
				signal: abort.signal,
			});

			if (!res.ok) {
				const err = await res.json().catch(() => ({ error: "request failed" }));
				appendLine(gid, `\x1b[31merror:\x1b[0m ${(err as Record<string, string>).error ?? res.statusText}`);
				gs.running = false;
				await scrollGroup(gid);
				return;
			}

			const reader = res.body?.getReader();
			if (!reader) {
				appendLine(gid, "\x1b[31merror:\x1b[0m no stream");
				gs.running = false;
				return;
			}

			// res.ok means the daemon received and processed the command.
			// For lifecycle commands the backend writes all SSE events
			// synchronously, so if we got here the action is committed
			// even if the TCP stream tears down before "started" arrives.
			if (cmd.key === "daemon-restart") initiated = true;

			const decoder = new TextDecoder();
			let buf = "";

			try {
				while (true) {
					const { done, value } = await reader.read();
					if (done) break;
					buf += decoder.decode(value, { stream: true });

					const parts = buf.split("\n\n");
					buf = parts.pop() ?? "";

					for (const part of parts) {
						const match = part.match(/^data:\s*(.+)$/m);
						if (!match) continue;
						try {
							const event = JSON.parse(match[1]);
							if (event.type === "started") initiated = true;
							if (event.type === "stdout" || event.type === "stderr") {
								const text = String(event.data).replace(/\n$/, "");
								if (text) {
									for (const line of text.split("\n")) {
										appendLine(gid, event.type === "stderr" ? `\x1b[33m${line}\x1b[0m` : line);
									}
									await scrollGroup(gid);
								}
							} else if (event.type === "exit") {
								appendLine(gid, event.code === 0
									? `\x1b[32m✓ exit 0\x1b[0m`
									: `\x1b[31m✗ exit ${event.code}\x1b[0m`);
								await scrollGroup(gid);
							} else if (event.type === "error") {
								appendLine(gid, `\x1b[31merror:\x1b[0m ${event.message}`);
								await scrollGroup(gid);
							}
						} catch {
							// malformed SSE event — skip
						}
					}
				}
			} finally {
				reader.releaseLock();
			}
		} catch (err) {
			if (!abort.signal.aborted) {
				const lifecycle = cmd.key === "daemon-stop" || cmd.key === "daemon-restart";
				if (lifecycle) {
					appendLine(gid, `\x1b[33mDaemon process ended\x1b[0m`);
				} else {
					appendLine(gid, `\x1b[31merror:\x1b[0m ${err instanceof Error ? err.message : "fetch failed"}`);
				}
			}
		}

		// Restart: poll until daemon comes back (only if restart was actually initiated)
		if (cmd.key === "daemon-restart" && initiated) {
			appendLine(gid, "\x1b[90mWaiting for daemon to restart...\x1b[0m");
			await scrollGroup(gid);
			let ok = false;
			for (let i = 0; i < 15; i++) {
				await new Promise<void>(r => setTimeout(r, 1000));
				try {
					const h = await fetch(`${API_BASE}/health`);
					if (h.ok) { ok = true; break; }
				} catch { /* still down */ }
			}
			appendLine(gid, ok
				? "\x1b[32m✓ Daemon restarted\x1b[0m"
				: "\x1b[31m✗ Daemon did not restart within 15s\x1b[0m");
			await scrollGroup(gid);
		}

		appendLine(gid, "");
		gs.running = false;
		await scrollGroup(gid);
	}

	async function execApi(gid: string, cmd: CommandDef): Promise<void> {
		const gs = panels[gid];
		if (!gs || gs.running || !cmd.path || !cmd.method) return;
		gs.running = true;
		gs.expanded = true;
		const start = performance.now();

		appendLine(gid, `\x1b[32m$\x1b[0m ${cmd.method} ${cmd.path}`);
		await scrollGroup(gid);

		try {
			const res = await fetch(`${API_BASE}${cmd.path}`, { method: cmd.method });
			const elapsed = Math.round(performance.now() - start);
			const ct = res.headers.get("content-type") ?? "";
			const body = ct.includes("json")
				? JSON.stringify(await res.json(), null, 2)
				: await res.text();

			appendLine(gid, res.ok
				? `\x1b[32m${res.status} OK\x1b[0m  \x1b[90m${elapsed}ms\x1b[0m`
				: `\x1b[31m${res.status} FAILED\x1b[0m  \x1b[90m${elapsed}ms\x1b[0m`);

			for (const line of body.split("\n")) {
				appendLine(gid, line);
			}
		} catch (err) {
			appendLine(gid, `\x1b[31merror:\x1b[0m ${err instanceof Error ? err.message : "fetch failed"}`);
		}

		appendLine(gid, "");
		gs.running = false;
		await scrollGroup(gid);
	}

	function exec(gid: string, cmd: CommandDef): void {
		if (cmd.kind === "cli") void execCli(gid, cmd);
		else void execApi(gid, cmd);
	}

	function escapeHtml(s: string): string {
		return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
	}

	function ansiToHtml(text: string): string {
		const colors: Record<string, string> = {
			"31": "var(--sig-danger)",
			"32": "var(--sig-success)",
			"33": "var(--sig-warning, #e8a832)",
			"90": "var(--sig-text-muted)",
			"36": "var(--sig-accent)",
		};
		// Escape all HTML first to prevent XSS, then apply styling
		let result = escapeHtml(text);
		// Process ANSI color codes (now operating on escaped text)
		result = result.replace(/\x1b\[(\d+)m([\s\S]*?)\x1b\[0m/g, (_, code, content) => {
			const color = colors[code];
			if (color) return `<span style="color:${color}">${content}</span>`;
			if (code === "1") return `<strong>${content}</strong>`;
			return content;
		});
		result = result.replace(/\x1b\[\d+m/g, "");
		// JSON syntax highlighting (content already escaped — safe to wrap in spans)
		result = result.replace(/(&quot;(?:\\.|[^&])*?&quot;)\s*:/g, (_, key) => `<span style="color:var(--sig-accent)">${key}</span>:`);
		result = result.replace(/:\s*(&quot;(?:\\.|[^&])*?&quot;)(?=[,\n\r}\]])/g, (_, val) => `: <span style="color:var(--sig-success)">${val}</span>`);
		result = result.replace(/:\s*(true|false|null)(?=[,\n\r}\]])/g, (_, val) => `: <span style="color:var(--sig-warning, #e8a832)">${val}</span>`);
		result = result.replace(/:\s*(\d+\.?\d*)(?=[,\n\r}\]])/g, (_, val) => `: <span style="color:var(--sig-highlight-text)">${val}</span>`);
		return result;
	}
</script>

<div class="ts-root">
	{#each groupDefs as group (group.id)}
		{@const gs = panels[group.id]}
		<div class="ts-panel" class:ts-panel--collapsed={!gs.expanded} style="--panel-color: {group.color}">
			<!-- Panel header row -->
			<div class="ts-panel-header-row">
				<button class="ts-panel-header" onclick={() => toggleGroup(group.id)}>
					<svelte:component this={group.icon} class="size-3.5" style="color: {group.color}" />
					<span class="ts-panel-title">{group.title}</span>
					{#if gs.running}
						<Loader class="size-3 ts-spin" style="color: var(--sig-highlight-text)" />
					{/if}
					{#if gs.lines.length > 0}
						<span class="ts-panel-count">{gs.lines.length}</span>
					{/if}
					<ChevronDown class={`size-3 ts-chevron ${gs.expanded ? "" : "ts-chevron--closed"}`} />
				</button>
				{#if gs.lines.length > 0}
					<button
						class="ts-header-clear"
						title="Clear output"
						onclick={() => clearGroup(group.id)}
					>
						<Trash2 class="size-3" />
					</button>
				{/if}
			</div>

			{#if gs.expanded}
				<!-- Terminal output -->
				<div class="ts-term" use:bindTerm={group.id} role="log">
					{#if gs.lines.length === 0}
						<div class="ts-empty">no output yet</div>
					{:else}
						{#each gs.lines as line, i (i)}
							<div class="ts-line">{@html ansiToHtml(line) || "&nbsp;"}</div>
						{/each}
					{/if}
				</div>

				<!-- Command select + run -->
				<div class="ts-action-bar">
					<Select.Root
						type="single"
						value={String(gs.selected)}
						onValueChange={(v) => { if (v !== undefined) gs.selected = Number(v); }}
						disabled={gs.running}
					>
						<Select.Trigger class="ts-select">
							{group.commands[gs.selected]?.label ?? "Select command"}
						</Select.Trigger>
						<Select.Content class="ts-select-content">
							{#each group.commands as cmd, i (cmd.key ?? cmd.path)}
								<Select.Item value={String(i)} label={cmd.label} class="ts-select-item">
									{cmd.label}
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>
					<button
						class="ts-run"
						disabled={gs.running}
						onclick={() => exec(group.id, group.commands[gs.selected])}
					>
						{#if gs.running}
							<Loader class="size-3 ts-spin" />
						{:else}
							Run
						{/if}
					</button>
					{#if gs.lines.length > 0}
						<button
							class="ts-clear"
							onclick={() => clearGroup(group.id)}
							title="Clear output"
						>
							<Trash2 class="size-3" />
						</button>
					{/if}
				</div>
			{/if}
		</div>
	{/each}
</div>

<style>
	.ts-root {
		display: grid;
		grid-template-columns: 1fr 1fr;
		flex: 1;
		min-height: 0;
		overflow-y: auto;
		padding: var(--space-md);
		gap: 10px;
		align-items: stretch;
	}

	@media (min-width: 900px) {
		.ts-root {
			grid-template-columns: 1fr 1fr;
		}
	}

	@media (max-width: 480px) {
		.ts-root {
			grid-template-columns: 1fr;
		}
	}

	/* ── Panel ── */
	.ts-panel {
		display: flex;
		flex-direction: column;
		border: 1px solid var(--sig-border);
		border-radius: 8px;
		background: var(--sig-surface);
		overflow: hidden;
	}

	.ts-panel--collapsed {
		/* keep collapsed panels minimal */
	}

	.ts-panel-header-row {
		display: flex;
		align-items: center;
		border-bottom: 1px solid var(--sig-border);
	}

	.ts-panel--collapsed .ts-panel-header-row {
		border-bottom-color: transparent;
	}

	.ts-panel-header {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: 10px 14px;
		padding-right: 6px;
		background: transparent;
		border: none;
		color: var(--sig-text-bright);
		font-family: var(--font-display);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.08em;
		cursor: pointer;
		transition: background 0.15s ease;
		flex: 1;
		text-align: left;
	}

	.ts-header-clear {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		background: transparent;
		border: none;
		border-radius: 5px;
		color: var(--sig-text-muted);
		cursor: pointer;
		transition: color 0.15s ease;
		flex-shrink: 0;
		margin-right: 6px;
	}

	.ts-header-clear:hover {
		color: var(--sig-danger);
	}

	.ts-panel--collapsed .ts-panel-header {
		border-bottom-color: transparent;
	}

	.ts-panel-header:hover {
		background: var(--sig-surface-raised);
	}

	.ts-panel-title {
		flex: 1;
	}

	.ts-panel-count {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		padding: 0 4px;
		border-radius: 3px;
		line-height: 1.5;
	}

	.ts-chevron {
		color: var(--sig-text-muted);
		transition: transform 0.2s ease;
		flex-shrink: 0;
	}

	.ts-chevron--closed {
		transform: rotate(-90deg);
	}

	/* ── Terminal ── */
	.ts-term {
		flex: 1;
		min-height: 48px;
		max-height: 300px;
		overflow-y: auto;
		padding: 10px 14px;
		background: var(--sig-bg);
		font-family: var(--font-mono);
		font-size: 11px;
		line-height: 1.55;
		color: var(--sig-text);
	}

	.ts-empty {
		display: flex;
		align-items: center;
		justify-content: center;
		flex: 1;
		min-height: 48px;
		font-size: 10px;
		text-transform: uppercase;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
		opacity: 0.35;
	}

	.ts-line {
		white-space: pre-wrap;
		word-break: break-word;
		min-height: 1em;
	}

	/* ── Action bar ── */
	.ts-action-bar {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 10px 14px;
		border-top: 1px solid var(--sig-border);
		background: color-mix(in srgb, var(--sig-surface) 60%, var(--sig-bg));
	}

	:global(.ts-select) {
		flex: 1;
		height: 30px;
		background: var(--sig-surface) !important;
		border: 1px solid color-mix(in srgb, var(--panel-color) 25%, var(--sig-border)) !important;
		border-radius: 6px !important;
		color: var(--sig-text-bright) !important;
		font-family: var(--font-mono) !important;
		font-size: 10px !important;
		letter-spacing: 0.03em;
		padding: 0 10px !important;
	}

	:global(.ts-select:hover) {
		border-color: var(--panel-color) !important;
	}

	:global(.ts-select-content) {
		background: var(--sig-surface) !important;
		border: 1px solid var(--sig-border) !important;
		border-radius: 6px !important;
		font-family: var(--font-mono) !important;
		font-size: 10px !important;
	}

	:global(.ts-select-item) {
		font-family: var(--font-mono) !important;
		font-size: 10px !important;
		color: var(--sig-text) !important;
		padding: 6px 10px !important;
		border-radius: 4px !important;
		cursor: pointer !important;
	}

	:global(.ts-select-item:hover),
	:global(.ts-select-item[data-highlighted]) {
		background: var(--sig-surface-raised) !important;
		color: var(--sig-text-bright) !important;
	}

	:global(.ts-select-item[data-state="checked"]) {
		color: var(--panel-color, var(--sig-highlight-text)) !important;
	}

	.ts-run {
		display: inline-flex;
		align-items: center;
		justify-content: center;
		height: 30px;
		padding: 0 16px;
		background: color-mix(in srgb, var(--panel-color) 12%, var(--sig-surface));
		border: 1px solid color-mix(in srgb, var(--panel-color) 35%, var(--sig-border));
		border-radius: 6px;
		color: var(--panel-color);
		font-family: var(--font-mono);
		font-size: 10px;
		font-weight: 600;
		letter-spacing: 0.06em;
		text-transform: uppercase;
		cursor: pointer;
		transition: all 0.15s ease;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
		white-space: nowrap;
	}

	.ts-run:hover:not(:disabled) {
		background: color-mix(in srgb, var(--panel-color) 20%, var(--sig-surface));
		border-color: var(--panel-color);
		box-shadow: 0 0 10px color-mix(in srgb, var(--panel-color) 20%, transparent);
	}

	.ts-run:disabled {
		opacity: 0.4;
		cursor: default;
		box-shadow: none;
	}

	.ts-clear {
		display: grid;
		place-items: center;
		width: 28px;
		height: 28px;
		background: var(--sig-surface);
		border: 1px solid var(--sig-border);
		border-radius: 6px;
		color: var(--sig-text-muted);
		cursor: pointer;
		transition: all 0.15s ease;
		flex-shrink: 0;
		box-shadow: 0 1px 2px rgba(0, 0, 0, 0.15);
	}

	.ts-clear:hover {
		color: var(--sig-danger);
		border-color: var(--sig-danger);
	}

	:global(.ts-spin) { animation: ts-spin 0.8s linear infinite; }
	@keyframes ts-spin { to { transform: rotate(360deg); } }
</style>
