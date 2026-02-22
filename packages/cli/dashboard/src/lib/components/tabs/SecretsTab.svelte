<script lang="ts">
import { onMount } from "svelte";
import { getSecrets, putSecret, deleteSecret } from "$lib/api";
import { toast } from "$lib/stores/toast.svelte";

let secrets = $state<string[]>([]);
let secretsLoading = $state(false);
let newSecretName = $state("");
let newSecretValue = $state("");
let secretAdding = $state(false);
let secretDeleting = $state<string | null>(null);

async function fetchSecrets() {
	secretsLoading = true;
	secrets = await getSecrets();
	secretsLoading = false;
}

async function addSecret() {
	if (!newSecretName.trim() || !newSecretValue.trim()) return;
	secretAdding = true;
	const ok = await putSecret(newSecretName.trim(), newSecretValue);
	if (ok) {
		toast(`Secret ${newSecretName.trim()} added`, "success");
		newSecretName = "";
		newSecretValue = "";
		await fetchSecrets();
	} else {
		toast("Failed to add secret", "error");
	}
	secretAdding = false;
}

async function removeSecret(name: string) {
	secretDeleting = name;
	const ok = await deleteSecret(name);
	if (ok) {
		toast(`Secret ${name} deleted`, "success");
		await fetchSecrets();
	} else {
		toast("Failed to delete secret", "error");
	}
	secretDeleting = null;
}

onMount(() => {
	fetchSecrets();
});
</script>

<div class="flex h-full flex-col gap-[var(--space-md)] overflow-hidden p-[var(--space-md)]">
	<div class="flex shrink-0 gap-[var(--space-sm)]">
		<input
			type="text"
			class="flex-1 border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] px-3 py-2 font-[family-name:var(--font-mono)] text-[13px] text-[var(--sig-text-bright)] focus:border-[var(--sig-accent)] focus:outline-none"
			bind:value={newSecretName}
			placeholder="Secret name (e.g. OPENAI_API_KEY)"
		/>
		<input
			type="password"
			class="flex-1 border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] px-3 py-2 font-[family-name:var(--font-mono)] text-[13px] text-[var(--sig-text-bright)] focus:border-[var(--sig-accent)] focus:outline-none"
			bind:value={newSecretValue}
			placeholder="Secret value"
		/>
		<button
			class="cursor-pointer border-none bg-[var(--sig-text-bright)] px-3 py-[var(--space-xs)] text-[11px] font-medium text-[var(--sig-bg)] hover:bg-[var(--sig-text)] disabled:cursor-default disabled:opacity-40"
			onclick={addSecret}
			disabled={secretAdding || !newSecretName.trim() || !newSecretValue.trim()}
		>
			{secretAdding ? 'Adding...' : 'Add'}
		</button>
	</div>

	<div class="flex flex-1 flex-col gap-[var(--space-sm)] overflow-y-auto">
		{#if secretsLoading}
			<div class="p-8 text-center text-[var(--sig-text-muted)]">Loading secrets...</div>
		{:else if secrets.length === 0}
			<div class="p-8 text-center text-[var(--sig-text-muted)]">No secrets stored. Add one above.</div>
		{:else}
			{#each secrets as name}
				<div class="flex items-center gap-3 border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)] px-[var(--space-md)] py-3">
					<span class="flex-1 font-[family-name:var(--font-mono)] text-[13px] text-[var(--sig-text-bright)]">{name}</span>
					<span class="font-[family-name:var(--font-mono)] text-[12px] text-[var(--sig-text-muted)]">••••••••</span>
					<button
						class="cursor-pointer border border-[var(--sig-danger)] bg-transparent px-[10px] py-1 text-[11px] text-[var(--sig-danger)] enabled:hover:bg-[var(--sig-danger)] enabled:hover:text-[var(--sig-text-bright)] disabled:cursor-not-allowed disabled:opacity-50"
						onclick={() => removeSecret(name)}
						disabled={secretDeleting === name}
					>
						{secretDeleting === name ? '...' : 'Delete'}
					</button>
				</div>
			{/each}
		{/if}
	</div>
</div>
