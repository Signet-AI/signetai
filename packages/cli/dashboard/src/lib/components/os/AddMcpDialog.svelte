<script lang="ts">
	import { fetchTrayEntries } from "$lib/stores/os.svelte";
	import X from "@lucide/svelte/icons/x";
	import Loader from "@lucide/svelte/icons/loader";
	import CheckCircle from "@lucide/svelte/icons/check-circle-2";

	interface Props {
		open: boolean;
		onclose: () => void;
	}

	const { open, onclose }: Props = $props();

	const isDev = import.meta.env.DEV;
	const isTauri =
		typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
	const API_BASE = isDev || isTauri ? "http://localhost:3850" : "";

	let url = $state("");
	let name = $state("");
	let loading = $state(false);
	let error = $state<string | null>(null);
	let success = $state<string | null>(null);

	function reset(): void {
		url = "";
		name = "";
		loading = false;
		error = null;
		success = null;
	}

	function handleClose(): void {
		reset();
		onclose();
	}

	function handleBackdrop(e: MouseEvent): void {
		if (e.target === e.currentTarget) {
			handleClose();
		}
	}

	function handleKeydown(e: KeyboardEvent): void {
		if (e.key === "Escape") {
			handleClose();
		}
	}

	async function handleInstall(): Promise<void> {
		const trimmedUrl = url.trim();
		if (!trimmedUrl) {
			error = "Please enter an MCP server URL";
			return;
		}

		// Validate URL scheme to prevent SSRF (file://, ftp://, etc.)
		try {
			const parsed = new URL(trimmedUrl);
			if (!['https:', 'http:'].includes(parsed.protocol)) {
				error = 'Only HTTP/HTTPS URLs are supported';
				return;
			}
		} catch {
			error = 'Invalid URL format';
			return;
		}

		loading = true;
		error = null;
		success = null;

		try {
			const response = await fetch(`${API_BASE}/api/os/install`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify({
					url: trimmedUrl,
					name: name.trim() || undefined,
					autoPlace: false,
				}),
			});

			const data = await response.json();

			if (data.ok) {
				success = `Installed "${data.manifest?.name ?? data.widgetId}" successfully`;
				await fetchTrayEntries();
				// Auto-close after a short delay
				setTimeout(() => {
					handleClose();
				}, 1200);
			} else {
				error = data.error ?? "Install failed";
			}
		} catch (err) {
			error = err instanceof Error ? err.message : "Network error";
		} finally {
			loading = false;
		}
	}
</script>

{#if open}
	<!-- svelte-ignore a11y_no_noninteractive_element_interactions -->
	<div
		class="dialog-backdrop"
		role="dialog"
		aria-modal="true"
		aria-label="Add MCP Server"
		tabindex="-1"
		onclick={handleBackdrop}
		onkeydown={handleKeydown}
	>
		<div class="dialog-panel">
			<div class="dialog-header">
				<h3 class="dialog-title">Add MCP Server</h3>
				<button class="dialog-close" onclick={handleClose} title="Close">
					<X class="size-4" />
				</button>
			</div>

			<div class="dialog-body">
				<div class="field">
					<label for="mcp-url" class="field-label">Server URL</label>
					<input
						id="mcp-url"
						type="url"
						class="field-input"
						placeholder="https://mcp.example.com or mcpservers.org URL"
						bind:value={url}
						disabled={loading}
						onkeydown={(e) => { if (e.key === 'Enter' && !loading) handleInstall(); }}
					/>
					<span class="field-hint">Direct MCP server URL or mcpservers.org link</span>
				</div>

				<div class="field">
					<label for="mcp-name" class="field-label">
						Display Name <span class="field-optional">(optional)</span>
					</label>
					<input
						id="mcp-name"
						type="text"
						class="field-input"
						placeholder="My MCP Server"
						bind:value={name}
						disabled={loading}
						onkeydown={(e) => { if (e.key === 'Enter' && !loading) handleInstall(); }}
					/>
				</div>

				{#if error}
					<div class="dialog-message dialog-message--error">{error}</div>
				{/if}

				{#if success}
					<div class="dialog-message dialog-message--success">
						<CheckCircle class="size-3.5" />
						{success}
					</div>
				{/if}
			</div>

			<div class="dialog-footer">
				<button class="btn btn--ghost" onclick={handleClose} disabled={loading}>
					Cancel
				</button>
				<button class="btn btn--primary" onclick={handleInstall} disabled={loading || !url.trim()}>
					{#if loading}
						<Loader class="size-3.5 spin" />
						Installing…
					{:else}
						Install
					{/if}
				</button>
			</div>
		</div>
	</div>
{/if}

<style>
	.dialog-backdrop {
		position: fixed;
		inset: 0;
		z-index: 100;
		background: rgba(0, 0, 0, 0.6);
		display: flex;
		align-items: center;
		justify-content: center;
		padding: 16px;
	}

	.dialog-panel {
		background: var(--sig-surface);
		border: 1px solid var(--sig-border-strong);
		border-radius: 12px;
		width: 100%;
		max-width: 440px;
		box-shadow: 0 8px 32px rgba(0, 0, 0, 0.4);
		overflow: hidden;
	}

	.dialog-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: 16px 20px 12px;
		border-bottom: 1px solid var(--sig-border);
	}

	.dialog-title {
		font-family: var(--font-mono);
		font-size: 14px;
		font-weight: 600;
		color: var(--sig-text);
		margin: 0;
	}

	.dialog-close {
		background: none;
		border: none;
		color: var(--sig-text-muted);
		cursor: pointer;
		padding: 4px;
		border-radius: 4px;
		display: flex;
		align-items: center;
		justify-content: center;
	}

	.dialog-close:hover {
		color: var(--sig-text);
		background: var(--sig-surface-raised);
	}

	.dialog-body {
		padding: 16px 20px;
		display: flex;
		flex-direction: column;
		gap: 14px;
	}

	.field {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.field-label {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 500;
		color: var(--sig-text-muted);
		text-transform: uppercase;
		letter-spacing: 0.04em;
	}

	.field-optional {
		font-weight: 400;
		text-transform: none;
		opacity: 0.6;
	}

	.field-input {
		font-family: var(--font-mono);
		font-size: 13px;
		padding: 8px 10px;
		border: 1px solid var(--sig-border);
		border-radius: 6px;
		background: var(--sig-bg);
		color: var(--sig-text);
		outline: none;
		transition: border-color var(--dur) var(--ease);
	}

	.field-input:focus {
		border-color: var(--sig-highlight);
	}

	.field-input:disabled {
		opacity: 0.5;
		cursor: not-allowed;
	}

	.field-input::placeholder {
		color: var(--sig-text-muted);
		opacity: 0.5;
	}

	.field-hint {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text-muted);
		opacity: 0.6;
	}

	.dialog-message {
		font-family: var(--font-mono);
		font-size: 12px;
		padding: 8px 10px;
		border-radius: 6px;
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.dialog-message--error {
		background: rgba(239, 68, 68, 0.1);
		color: #ef4444;
		border: 1px solid rgba(239, 68, 68, 0.2);
	}

	.dialog-message--success {
		background: rgba(34, 197, 94, 0.1);
		color: #22c55e;
		border: 1px solid rgba(34, 197, 94, 0.2);
	}

	.dialog-footer {
		display: flex;
		justify-content: flex-end;
		gap: 8px;
		padding: 12px 20px 16px;
		border-top: 1px solid var(--sig-border);
	}

	.btn {
		font-family: var(--font-mono);
		font-size: 12px;
		font-weight: 500;
		padding: 6px 14px;
		border-radius: 6px;
		border: 1px solid transparent;
		cursor: pointer;
		display: flex;
		align-items: center;
		gap: 6px;
		transition: all var(--dur) var(--ease);
	}

	.btn:disabled {
		opacity: 0.4;
		cursor: not-allowed;
	}

	.btn--ghost {
		background: transparent;
		color: var(--sig-text-muted);
		border-color: var(--sig-border);
	}

	.btn--ghost:hover:not(:disabled) {
		background: var(--sig-surface-raised);
		color: var(--sig-text);
	}

	.btn--primary {
		background: var(--sig-highlight);
		color: var(--sig-highlight-text);
		border-color: var(--sig-highlight);
	}

	.btn--primary:hover:not(:disabled) {
		opacity: 0.9;
	}

	:global(.spin) {
		animation: spin 1s linear infinite;
	}

	@keyframes spin {
		from {
			transform: rotate(0deg);
		}
		to {
			transform: rotate(360deg);
		}
	}
</style>
