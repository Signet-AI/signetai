<script lang="ts">
import { browser } from "$app/environment";
import { type DaemonStatus, fetchChangelog } from "$lib/api";
import ExternalLink from "@lucide/svelte/icons/external-link";
import X from "@lucide/svelte/icons/x";

const STORAGE_KEY_PREFIX = "signet-upgrade-banner-dismissed-";
const CHANGELOG_URL = "https://github.com/Signet-AI/signetai/blob/main/CHANGELOG.md";

interface Props {
	daemonStatus: DaemonStatus | null;
	showing?: boolean;
}

let { daemonStatus, showing = $bindable(false) }: Props = $props();

let dismissed = $state(false);
let notes = $state<string[]>([]);

const version = $derived(daemonStatus?.version ?? null);
const key = $derived(version ? `${STORAGE_KEY_PREFIX}${version}` : null);

// Sync dismiss state from localStorage when version resolves
$effect(() => {
	if (!browser || !key) return;
	dismissed = localStorage.getItem(key) === "true";
});

function stripTags(html: string): string {
	if (!browser) return html.replace(/<[^>]*>/g, "");
	const el = document.createElement("div");
	el.innerHTML = html;
	return el.textContent ?? "";
}

// Fetch changelog and extract up to 3 items for the current version
$effect(() => {
	notes = [];
	if (!version || version === "0.0.0") return;
	const v = version;
	fetchChangelog()
		.then((doc) => {
			if (!doc?.html || version !== v) return;
			const anchor = doc.html.indexOf(`[${v}]`);
			if (anchor < 0) return;
			const slice = doc.html.slice(anchor);
			const items = slice.match(/<li[^>]*>([\s\S]*?)<\/li>/gi);
			if (!items) return;
			notes = items.slice(0, 3).map((li) => stripTags(li).trim());
		})
		.catch((e) => {
			if (import.meta.env.DEV) {
				console.warn("UpgradeBanner: changelog fetch failed", e);
			}
		});
});

const visible = $derived(!!version && version !== "0.0.0" && !dismissed);

$effect(() => {
	showing = visible;
});

function dismiss() {
	dismissed = true;
	if (browser && key) {
		localStorage.setItem(key, "true");
	}
}
</script>

{#if visible}
	<div class="banner">
		<span class="banner-accent" aria-hidden="true"></span>
		<a
			href={CHANGELOG_URL}
			target="_blank"
			rel="noopener noreferrer"
			class="banner-link"
		>
			<span class="banner-version">v{version}</span>
			<ExternalLink class="size-2.5" />
		</a>
		<span class="banner-separator" aria-hidden="true"></span>
		{#if notes.length > 0}
			<span class="banner-notes">
				{#each notes as note, i}
					<span class="banner-note">{note}</span>
					{#if i < notes.length - 1}
						<span class="banner-dot" aria-hidden="true">&middot;</span>
					{/if}
				{/each}
			</span>
			<span class="banner-separator" aria-hidden="true"></span>
		{/if}
		<a
			href={CHANGELOG_URL}
			target="_blank"
			rel="noopener noreferrer"
			class="banner-changelog-link"
		>
			View changelog
		</a>
		<button
			onclick={dismiss}
			class="banner-dismiss"
			aria-label="Dismiss upgrade banner"
		>
			<X class="size-3" />
		</button>
	</div>
{/if}

<style>
	.banner {
		display: flex;
		align-items: center;
		gap: 8px;
		height: 24px;
		padding: 0 12px;
		background: var(--sig-bg);
		border-bottom: 1px solid var(--sig-border);
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.06em;
		flex-shrink: 0;
	}

	.banner-accent {
		width: 3px;
		height: 10px;
		background: var(--sig-highlight);
		border-radius: 1px;
		flex-shrink: 0;
	}

	.banner-link {
		display: flex;
		align-items: center;
		gap: 4px;
		color: var(--sig-highlight);
		text-decoration: none;
		flex-shrink: 0;
		transition: opacity var(--dur) var(--ease);
	}

	.banner-link:hover {
		opacity: 0.8;
	}

	.banner-version {
		font-weight: 700;
		text-transform: uppercase;
	}

	.banner-separator {
		width: 1px;
		height: 8px;
		background: var(--sig-border-strong);
		flex-shrink: 0;
	}

	.banner-notes {
		display: flex;
		align-items: center;
		gap: 6px;
		min-width: 0;
		overflow: hidden;
	}

	.banner-note {
		color: var(--sig-text-muted);
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.banner-dot {
		color: var(--sig-border-strong);
		flex-shrink: 0;
	}

	.banner-changelog-link {
		color: var(--sig-accent);
		text-decoration: none;
		white-space: nowrap;
		flex-shrink: 0;
		transition: color var(--dur) var(--ease);
	}

	.banner-changelog-link:hover {
		color: var(--sig-text-bright);
	}

	.banner-dismiss {
		margin-left: auto;
		display: flex;
		align-items: center;
		justify-content: center;
		width: 18px;
		height: 18px;
		flex-shrink: 0;
		color: var(--sig-text-muted);
		background: none;
		border: none;
		border-radius: 2px;
		cursor: pointer;
		transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
	}

	.banner-dismiss:hover {
		color: var(--sig-text-bright);
		background: var(--sig-surface-raised);
	}
</style>
