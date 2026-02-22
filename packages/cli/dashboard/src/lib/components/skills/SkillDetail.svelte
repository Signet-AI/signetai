<script lang="ts">
import { marked } from "marked";
import * as Sheet from "$lib/components/ui/sheet/index.js";
import { Badge } from "$lib/components/ui/badge/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { sk, doInstall, doUninstall, closeDetail } from "$lib/stores/skills.svelte";
import { toast } from "$lib/stores/toast.svelte";

let open = $derived(sk.detailOpen);

let isInstalled = $derived(
	sk.selectedName
		? sk.installed.some((s) => s.name === sk.selectedName)
		: false,
);

function handleOpenChange(value: boolean) {
	if (!value) closeDetail();
}

let renderedContent = $derived.by(() => {
	if (!sk.detailContent) return "";
	const content = sk.detailContent.replace(/^---[\s\S]*?---\n*/, "");
	return marked.parse(content, { async: false }) as string;
});

let copied = $state(false);
async function copyInstallCommand() {
	const name = sk.selectedName;
	if (!name) return;
	try {
		await navigator.clipboard.writeText(`npx skills add ${name}`);
		copied = true;
		setTimeout(() => (copied = false), 1500);
	} catch {
		toast("Copy failed", "error");
	}
}
</script>

<Sheet.Root bind:open onOpenChange={handleOpenChange}>
	<Sheet.Content
		side="right"
		class="!w-[520px] !max-w-[90vw] !bg-[var(--sig-surface)]
			!border-l !border-l-[var(--sig-border)] !p-0 flex flex-col"
	>
		{#if sk.detailLoading}
			<div class="flex-1 flex items-center justify-center">
				<span class="text-[var(--sig-text-muted)] text-[12px]">
					Loading...
				</span>
			</div>
		{:else}
			<!-- Header -->
			<div class="px-5 pt-5 pb-4 border-b border-[var(--sig-border)]">
				<div class="flex items-start justify-between gap-4">
					<div class="flex flex-col gap-1 min-w-0">
						<h2 class="detail-title">{sk.selectedName}</h2>
						{#if sk.detailMeta}
							<div class="flex items-center gap-2 flex-wrap">
								{#if sk.detailMeta.user_invocable}
									<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] border-[var(--sig-accent)] text-[var(--sig-accent)]">
										/{sk.detailMeta.name}
									</Badge>
								{/if}
								{#if sk.detailMeta.builtin}
									<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] border-[var(--sig-accent)] text-[var(--sig-accent)]">Built-in</Badge>
								{/if}
								{#if sk.detailMeta.arg_hint}
									<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] border-[var(--sig-border-strong)] text-[var(--sig-text-muted)]">
										{sk.detailMeta.arg_hint}
									</Badge>
								{/if}
							</div>
						{/if}
					</div>

					<!-- Action button -->
					<div class="shrink-0">
						{#if sk.detailMeta?.builtin}
							<Badge variant="outline" class="rounded-none font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] border-[var(--sig-border-strong)] text-[var(--sig-text-muted)]">System</Badge>
						{:else if isInstalled}
							<Button
								variant="outline"
								size="sm"
								class="rounded-none font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] border-[var(--sig-danger)] text-[var(--sig-danger)] hover:bg-[var(--sig-danger)] hover:text-[var(--sig-text-bright)]"
								onclick={() => sk.detailMeta && doUninstall(sk.detailMeta.name)}
								disabled={sk.uninstalling === sk.detailMeta?.name}
							>
								{sk.uninstalling === sk.detailMeta?.name ? "..." : "Uninstall"}
							</Button>
						{:else}
							<Button
								variant="outline"
								size="sm"
								class="rounded-none font-[family-name:var(--font-mono)] text-[10px] uppercase tracking-[0.08em] border-[var(--sig-text-bright)] text-[var(--sig-text-bright)] hover:bg-[var(--sig-text-bright)] hover:text-[var(--sig-bg)]"
								onclick={() => sk.selectedName && doInstall(sk.selectedName)}
								disabled={sk.installing === sk.selectedName}
							>
								{sk.installing === sk.selectedName ? "..." : "Install"}
							</Button>
						{/if}
					</div>
				</div>

				<!-- Install command -->
				<button
					type="button"
					class="detail-cmd"
					onclick={copyInstallCommand}
					title="Click to copy"
				>
					<span class="opacity-50">$</span>
					npx skills add {sk.selectedName}
					<span class="detail-cmd-hint">
						{copied ? "copied!" : "click to copy"}
					</span>
				</button>
			</div>

			<!-- Body -->
			<div class="flex-1 overflow-y-auto px-5 py-4">
				{#if renderedContent}
					<div class="skill-markdown">
						{@html renderedContent}
					</div>
				{:else if sk.detailMeta?.description}
					<p class="text-[12px] text-[var(--sig-text)] leading-[1.6]">
						{sk.detailMeta.description}
					</p>
				{:else}
					<p class="text-[12px] text-[var(--sig-text-muted)]">
						No documentation available.
					</p>
				{/if}
			</div>
		{/if}
	</Sheet.Content>
</Sheet.Root>

<style>
	.detail-title {
		font-family: var(--font-display);
		font-size: 16px;
		font-weight: 700;
		color: var(--sig-text-bright);
		text-transform: uppercase;
		letter-spacing: 0.06em;
		margin: 0;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.detail-cmd {
		display: flex;
		align-items: center;
		gap: 6px;
		width: 100%;
		text-align: left;
		margin-top: 12px;
		padding: 6px 10px;
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text);
		background: var(--sig-bg);
		border: 1px solid var(--sig-border-strong);
		cursor: pointer;
		transition: border-color 0.15s;
	}
	.detail-cmd:hover {
		border-color: var(--sig-accent);
	}
	.detail-cmd-hint {
		margin-left: auto;
		font-size: 9px;
		color: var(--sig-text-muted);
		opacity: 0.6;
	}

	:global(.skill-markdown) {
		font-size: 12px;
		line-height: 1.7;
		color: var(--sig-text);
	}
	:global(.skill-markdown h1),
	:global(.skill-markdown h2),
	:global(.skill-markdown h3) {
		font-family: var(--font-display);
		color: var(--sig-text-bright);
		text-transform: uppercase;
		letter-spacing: 0.04em;
		margin-top: 1.5em;
		margin-bottom: 0.5em;
	}
	:global(.skill-markdown h1) { font-size: 14px; }
	:global(.skill-markdown h2) { font-size: 13px; }
	:global(.skill-markdown h3) { font-size: 12px; }
	:global(.skill-markdown p) {
		margin: 0.5em 0;
	}
	:global(.skill-markdown code) {
		font-family: var(--font-mono);
		font-size: 11px;
		background: var(--sig-bg);
		padding: 2px 5px;
		border: 1px solid var(--sig-border);
	}
	:global(.skill-markdown pre) {
		background: var(--sig-bg);
		border: 1px solid var(--sig-border);
		padding: var(--space-sm);
		overflow-x: auto;
		margin: 0.75em 0;
	}
	:global(.skill-markdown pre code) {
		background: none;
		border: none;
		padding: 0;
	}
	:global(.skill-markdown ul),
	:global(.skill-markdown ol) {
		padding-left: 1.5em;
		margin: 0.5em 0;
	}
	:global(.skill-markdown li) {
		margin: 0.25em 0;
	}
	:global(.skill-markdown a) {
		color: var(--sig-accent);
		text-decoration: none;
	}
	:global(.skill-markdown a:hover) {
		text-decoration: underline;
	}
</style>
