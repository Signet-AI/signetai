<script lang="ts">
import { type SessionInfo, fetchSessions, toggleSessionBypass } from "$lib/api";
import { Badge } from "$lib/components/ui/badge/index.js";
import * as Switch from "$lib/components/ui/switch/index.js";
import { toast } from "$lib/stores/toast.svelte";

let sessions: SessionInfo[] = $state([]);
let loading = $state(true);
let pending = $state(new Set<string>());

async function load(): Promise<void> {
	try {
		const data = await fetchSessions();
		sessions = [...data.sessions];
	} catch {
		toast("Failed to load sessions", "error");
	} finally {
		loading = false;
	}
}

async function handleToggle(session: SessionInfo, enabled: boolean): Promise<void> {
	if (pending.has(session.key)) return;
	pending = new Set([...pending, session.key]);
	try {
		const result = await toggleSessionBypass(session.key, enabled);
		if (result) {
			sessions = sessions.map((s) => (s.key === session.key ? { ...s, bypassed: result.bypassed } : s));
		} else {
			toast("Failed to toggle bypass", "error");
		}
	} finally {
		const next = new Set(pending);
		next.delete(session.key);
		pending = next;
	}
}

function formatRelativeTime(ts: string): string {
	const deltaMs = Date.now() - new Date(ts).getTime();
	if (!Number.isFinite(deltaMs) || deltaMs < 0) return "just now";
	const sec = Math.floor(deltaMs / 1000);
	if (sec < 60) return `${sec}s ago`;
	const min = Math.floor(sec / 60);
	if (min < 60) return `${min}m ago`;
	const hr = Math.floor(min / 60);
	if (hr < 24) return `${hr}h ago`;
	return `${Math.floor(hr / 24)}d ago`;
}

$effect(() => {
	load();
	const interval = setInterval(load, 30_000);
	return () => clearInterval(interval);
});
</script>

{#if !loading && sessions.length > 0}
	<div class="mb-4">
		<div class="flex items-center gap-2 mb-2">
			<span class="sig-heading">ACTIVE SESSIONS</span>
			<Badge variant="outline" class="sig-badge px-1.5 py-0">
				{sessions.length}
			</Badge>
		</div>
		<div
			class="rounded-md border border-[var(--sig-border)]"
			style="background: var(--sig-surface)"
		>
			{#each sessions as session, i (session.key)}
				{#if i > 0}
					<div class="border-t border-[var(--sig-border)]"></div>
				{/if}
				<div class="flex items-center justify-between px-3 py-2 gap-3">
					<div class="flex items-center gap-3 min-w-0">
						<span
							class="font-mono text-[var(--font-size-sm)] text-[var(--sig-text)] truncate"
							title={session.key}
						>
							{session.key.slice(0, 12)}
						</span>
						<Badge variant="outline" class="sig-badge px-1.5 py-0 shrink-0">
							{session.runtimePath}
						</Badge>
						<span class="sig-meta text-[var(--sig-text-muted)] shrink-0">
							{formatRelativeTime(session.claimedAt)}
						</span>
					</div>
					<div class="flex items-center gap-2 shrink-0">
						<span class="sig-meta" class:text-[var(--sig-text-muted)]={!session.bypassed} class:text-[var(--sig-accent)]={session.bypassed}>
							{session.bypassed ? "bypassed" : "active"}
						</span>
						<Switch.Root
							checked={session.bypassed}
							disabled={pending.has(session.key)}
							onCheckedChange={(checked: boolean) => handleToggle(session, checked)}
							aria-label="Bypass session {session.key}"
						>
							<Switch.Thumb />
						</Switch.Root>
					</div>
				</div>
			{/each}
		</div>
	</div>
{/if}
