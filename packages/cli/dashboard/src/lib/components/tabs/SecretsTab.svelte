<script lang="ts">
	import { onMount } from "svelte";
	import { getSecrets, putSecret, deleteSecret } from "$lib/api";

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
			newSecretName = "";
			newSecretValue = "";
			await fetchSecrets();
		}
		secretAdding = false;
	}

	async function removeSecret(name: string) {
		secretDeleting = name;
		const ok = await deleteSecret(name);
		if (ok) {
			await fetchSecrets();
		}
		secretDeleting = null;
	}

	onMount(() => {
		fetchSecrets();
	});
</script>

<div class="secrets-container">
	<div class="secrets-add">
		<input
			type="text"
			class="secrets-input"
			bind:value={newSecretName}
			placeholder="Secret name (e.g. OPENAI_API_KEY)"
		/>
		<input
			type="password"
			class="secrets-input"
			bind:value={newSecretValue}
			placeholder="Secret value"
		/>
		<button
			class="btn-primary"
			onclick={addSecret}
			disabled={secretAdding || !newSecretName.trim() || !newSecretValue.trim()}
		>
			{secretAdding ? 'Adding...' : 'Add'}
		</button>
	</div>

	<div class="secrets-list">
		{#if secretsLoading}
			<div class="secrets-empty">Loading secrets...</div>
		{:else if secrets.length === 0}
			<div class="secrets-empty">No secrets stored. Add one above.</div>
		{:else}
			{#each secrets as name}
				<div class="secret-item">
					<span class="secret-name">{name}</span>
					<span class="secret-value">••••••••</span>
					<button
						class="btn-danger-small"
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
