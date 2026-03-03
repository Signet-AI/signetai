<script lang="ts">
import {
	type OnePasswordStatus,
	type OnePasswordVault,
	connectOnePassword,
	deleteSecret,
	disconnectOnePassword,
	getOnePasswordStatus,
	getSecrets,
	importOnePasswordSecrets,
	listOnePasswordVaults,
	putSecret,
} from "$lib/api";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { toast } from "$lib/stores/toast.svelte";
import { ActionLabels } from "$lib/ui/action-labels";
import { onMount } from "svelte";

let secrets = $state<string[]>([]);
let secretsLoading = $state(false);
let newSecretName = $state("");
let newSecretValue = $state("");
let secretAdding = $state(false);
let secretDeleting = $state<string | null>(null);

let onePasswordLoading = $state(false);
let onePasswordStatus = $state<OnePasswordStatus>({
	configured: false,
	connected: false,
	vaults: [],
});
let onePasswordVaults = $state<readonly OnePasswordVault[]>([]);
let onePasswordToken = $state("");
const onePasswordImportOptions = $state({
	prefix: "OP",
	overwrite: false,
});
let onePasswordConnecting = $state(false);
let onePasswordDisconnecting = $state(false);
let onePasswordImporting = $state(false);
let selectedVaultIds = $state<string[]>([]);

async function fetchSecrets() {
	secretsLoading = true;
	secrets = await getSecrets();
	secretsLoading = false;
}

function toggleVaultSelection(vaultId: string): void {
	if (selectedVaultIds.includes(vaultId)) {
		selectedVaultIds = selectedVaultIds.filter((id) => id !== vaultId);
		return;
	}
	selectedVaultIds = [...selectedVaultIds, vaultId];
}

async function refreshOnePasswordStatus(): Promise<void> {
	onePasswordLoading = true;
	try {
		onePasswordStatus = await getOnePasswordStatus();
		if (onePasswordStatus.connected) {
			const fetchedVaults = await listOnePasswordVaults();
			onePasswordVaults = fetchedVaults.length > 0 ? fetchedVaults : onePasswordStatus.vaults;
		} else {
			onePasswordVaults = [];
			selectedVaultIds = [];
		}

		const knownIds = new Set(onePasswordVaults.map((vault) => vault.id));
		selectedVaultIds = selectedVaultIds.filter((id) => knownIds.has(id));
	} finally {
		onePasswordLoading = false;
	}
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

async function connectOnePasswordAccount(): Promise<void> {
	if (!onePasswordToken.trim()) {
		toast("Service account token is required", "error");
		return;
	}

	onePasswordConnecting = true;
	const result = await connectOnePassword(onePasswordToken.trim());
	onePasswordConnecting = false;

	if (!result.success) {
		toast(result.error ?? "Failed to connect 1Password", "error");
		return;
	}

	onePasswordToken = "";
	await refreshOnePasswordStatus();
	toast("Connected to 1Password", "success");
}

async function disconnectOnePasswordAccount(): Promise<void> {
	onePasswordDisconnecting = true;
	const result = await disconnectOnePassword();
	onePasswordDisconnecting = false;

	if (!result.success) {
		toast(result.error ?? "Failed to disconnect 1Password", "error");
		return;
	}

	await refreshOnePasswordStatus();
	toast("Disconnected 1Password", "success");
}

async function importFromOnePassword(): Promise<void> {
	if (!onePasswordStatus.connected) {
		toast("Connect 1Password first", "error");
		return;
	}

	onePasswordImporting = true;
	const result = await importOnePasswordSecrets({
		vaults: selectedVaultIds.length > 0 ? selectedVaultIds : undefined,
		prefix: onePasswordImportOptions.prefix.trim() || "OP",
		overwrite: onePasswordImportOptions.overwrite,
	});
	onePasswordImporting = false;

	if (!result.success) {
		toast(result.error ?? "Failed to import from 1Password", "error");
		return;
	}

	await fetchSecrets();
	const importedCount = result.importedCount ?? 0;
	const skippedCount = result.skippedCount ?? 0;
	const errorCount = result.errorCount ?? 0;
	toast(`Imported ${importedCount} secrets (skipped ${skippedCount}, errors ${errorCount})`, "success");
}

onMount(() => {
	fetchSecrets();
	refreshOnePasswordStatus();
});
</script>

<div class="flex h-full flex-col overflow-hidden">
	<div
		class="grid flex-1 gap-[var(--space-md)] overflow-hidden p-[var(--space-md)]
			xl:grid-cols-[1.2fr_0.8fr]"
	>
		<div class="flex min-h-0 flex-col gap-[var(--space-sm)] overflow-hidden">
			<div class="flex shrink-0 gap-[var(--space-sm)]">
				<Input
					type="text"
					class="flex-1 rounded-lg border-[var(--sig-border-strong)]
						bg-[var(--sig-surface-raised)] font-[family-name:var(--font-mono)]
						text-[13px] text-[var(--sig-text-bright)]
						focus:border-[var(--sig-accent)]"
					bind:value={newSecretName}
					placeholder="Secret name (e.g. OPENAI_API_KEY)"
				/>
				<Input
					type="password"
					class="flex-1 rounded-lg border-[var(--sig-border-strong)]
						bg-[var(--sig-surface-raised)] font-[family-name:var(--font-mono)]
						text-[13px] text-[var(--sig-text-bright)]
						focus:border-[var(--sig-accent)]"
					bind:value={newSecretValue}
					placeholder="Secret value"
				/>
				<Button
					class="rounded-lg bg-[var(--sig-text-bright)] text-[var(--sig-bg)]
						hover:bg-[var(--sig-text)] text-[11px] font-medium"
					size="sm"
					onclick={addSecret}
					disabled={secretAdding || !newSecretName.trim() || !newSecretValue.trim()}
				>
					{secretAdding ? "Adding..." : ActionLabels.Add}
				</Button>
			</div>

			<div class="flex flex-1 flex-col gap-[var(--space-sm)] overflow-y-auto">
				{#if secretsLoading}
					<div class="p-8 text-center text-[var(--sig-text-muted)]">
						Loading secrets...
					</div>
				{:else if secrets.length === 0}
					<div class="p-8 text-center text-[var(--sig-text-muted)]">
						No secrets stored. Add one above.
					</div>
				{:else}
					{#each secrets as name}
						<div
							class="flex items-center gap-3 border border-[var(--sig-border-strong)]
								bg-[var(--sig-surface-raised)] px-[var(--space-md)] py-3 rounded-lg"
						>
							<span class="flex-1 font-[family-name:var(--font-mono)] text-[13px] text-[var(--sig-text-bright)]"
								>{name}</span
							>
							<span class="font-[family-name:var(--font-mono)] text-[12px] text-[var(--sig-text-muted)]"
								>••••••••</span
							>
							<Button
								variant="outline"
								size="sm"
								class="rounded-lg border-[var(--sig-danger)] text-[var(--sig-danger)]
									text-[11px] hover:bg-[var(--sig-danger)] hover:text-[var(--sig-text-bright)]"
								onclick={() => removeSecret(name)}
								disabled={secretDeleting === name}
							>
								{secretDeleting === name ? "..." : ActionLabels.Delete}
							</Button>
						</div>
					{/each}
				{/if}
			</div>
		</div>

		<div class="flex min-h-0 flex-col gap-[var(--space-sm)] overflow-hidden">
			<div
				class="flex min-h-0 flex-1 flex-col gap-[var(--space-sm)] overflow-hidden
					border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)]
					p-[var(--space-md)] rounded-lg"
			>
				<div class="flex items-center justify-between gap-3">
					<div class="sig-label uppercase tracking-[0.08em]">
						1Password
					</div>
					<Button
						variant="outline"
						size="sm"
						class="rounded-lg text-[11px]"
						onclick={refreshOnePasswordStatus}
						disabled={onePasswordLoading}
					>
						{onePasswordLoading ? "Refreshing..." : "Refresh"}
					</Button>
				</div>

				{#if onePasswordStatus.connected}
					<div class="text-[12px] text-emerald-400">
						Connected.
						{#if typeof onePasswordStatus.vaultCount === "number"}
							{onePasswordStatus.vaultCount} vaults available.
						{/if}
					</div>
				{:else if onePasswordStatus.configured}
					<div class="text-[12px] text-amber-400">
						Token saved, but 1Password is not reachable.
						{#if onePasswordStatus.error}
							{onePasswordStatus.error}
						{/if}
					</div>
				{:else}
					<div class="text-[12px] text-[var(--sig-text-muted)]">
						Connect a 1Password service account to import secrets.
					</div>
				{/if}

				<div class="flex gap-[var(--space-sm)]">
					<Input
						type="password"
						class="rounded-lg border-[var(--sig-border-strong)]
							bg-[var(--sig-surface)] font-[family-name:var(--font-mono)]
							text-[13px] text-[var(--sig-text-bright)]"
						bind:value={onePasswordToken}
						placeholder={onePasswordStatus.connected
							? "Replace service account token"
							: "1Password service account token"}
					/>
					<Button
						size="sm"
						class="rounded-lg bg-[var(--sig-text-bright)] text-[var(--sig-bg)] text-[11px] hover:bg-[var(--sig-text)]"
						onclick={connectOnePasswordAccount}
						disabled={onePasswordConnecting || !onePasswordToken.trim()}
					>
						{onePasswordConnecting
							? "Connecting..."
							: onePasswordStatus.connected
								? "Update Token"
								: "Connect"}
					</Button>
				</div>

				<div class="grid grid-cols-[auto_1fr] items-center gap-x-3 gap-y-2">
					<label for="op-prefix" class="text-[12px] text-[var(--sig-text-muted)]"
						>Prefix</label
					>
					<Input
						id="op-prefix"
						type="text"
						class="h-8 rounded-lg border-[var(--sig-border-strong)]
							bg-[var(--sig-surface)] font-[family-name:var(--font-mono)]
							text-[12px] text-[var(--sig-text-bright)]"
						bind:value={onePasswordImportOptions.prefix}
						placeholder="OP"
					/>
					<label class="text-[12px] text-[var(--sig-text-muted)]"
						for="op-overwrite">Overwrite</label
					>
					<label id="op-overwrite" class="flex items-center gap-2 text-[12px] text-[var(--sig-text-muted)]">
						<input
							type="checkbox"
							bind:checked={onePasswordImportOptions.overwrite}
						/>
						Overwrite existing secret names
					</label>
				</div>

				<div class="min-h-0 flex-1 overflow-y-auto border border-[var(--sig-border)] p-2 rounded-lg">
					{#if !onePasswordStatus.connected}
						<div class="px-2 py-3 text-[12px] text-[var(--sig-text-muted)]">
							Connect first, then choose vaults to import. Leave all unchecked to import from every vault.
						</div>
					{:else if onePasswordVaults.length === 0}
						<div class="px-2 py-3 text-[12px] text-[var(--sig-text-muted)]">
							No accessible vaults found.
						</div>
					{:else}
						{#each onePasswordVaults as vault}
							<label
								class="flex cursor-pointer items-center gap-2 px-2 py-1 text-[12px]
									text-[var(--sig-text)] hover:bg-[var(--sig-surface)]"
							>
								<input
									type="checkbox"
									checked={selectedVaultIds.includes(vault.id)}
									onchange={() => toggleVaultSelection(vault.id)}
								/>
								<span class="font-[family-name:var(--font-mono)]">{vault.name}</span>
								<span class="text-[var(--sig-text-dim)]">({vault.id})</span>
							</label>
						{/each}
					{/if}
				</div>

				<div class="flex flex-wrap gap-[var(--space-sm)]">
					<Button
						size="sm"
						class="rounded-lg bg-[var(--sig-text-bright)] text-[var(--sig-bg)] text-[11px] hover:bg-[var(--sig-text)]"
						onclick={importFromOnePassword}
						disabled={onePasswordImporting || !onePasswordStatus.connected}
					>
						{onePasswordImporting ? "Importing..." : "Import Into Signet"}
					</Button>
					<Button
						variant="outline"
						size="sm"
						class="rounded-lg border-[var(--sig-danger)] text-[var(--sig-danger)]
							text-[11px] hover:bg-[var(--sig-danger)] hover:text-[var(--sig-text-bright)]"
						onclick={disconnectOnePasswordAccount}
						disabled={onePasswordDisconnecting || !onePasswordStatus.configured}
					>
						{onePasswordDisconnecting ? "Disconnecting..." : "Disconnect"}
					</Button>
				</div>

				<div class="text-[11px] text-[var(--sig-text-dim)]">
					Tip: you can also map direct refs in command execution as
					<span class="font-[family-name:var(--font-mono)]">op://vault/item/field</span>.
				</div>
			</div>
		</div>
	</div>
</div>
