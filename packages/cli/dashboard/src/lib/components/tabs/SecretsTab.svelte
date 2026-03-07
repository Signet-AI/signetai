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
import { returnToSidebar } from "$lib/stores/focus.svelte";
import { nav } from "$lib/stores/navigation.svelte";
import { Checkbox } from "$lib/components/ui/checkbox/index.js";
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
let focusedSecretIndex = $state(-1); // -1 means no secret focused
let focusArea = $state<'list' | '1password'>('list'); // Track which area has focus
let focusedOnePasswordInput = $state(-1); // -1 means panel itself, 0+ = input index

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

// Keyboard navigation
function handleGlobalKey(e: KeyboardEvent) {
	// Only handle events when Secrets tab is active
	if (nav.activeTab !== "secrets") return;

	// Skip events already handled by local handlers
	if (e.defaultPrevented) return;

	const target = e.target as HTMLElement;
	const isInputFocused =
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.isContentEditable;

	if (isInputFocused) return;

	// Right Arrow to focus first secret or 1Password panel (only when at page level)
	if (e.key === "ArrowRight" && focusArea === "list" && focusedSecretIndex === -1) {
		e.preventDefault();
		if (secrets.length > 0) {
			focusedSecretIndex = 0;
			focusSecretItem(0);
		} else {
			// No secrets — jump to 1Password panel
			focusArea = "1password";
			focusedOnePasswordInput = 0;
			focusOnePasswordInputField(0);
		}
	}

	// Arrow Up/Down to navigate secrets when in list area
	if (e.key === "ArrowUp" && focusArea === "list" && focusedSecretIndex >= 0) {
		e.preventDefault();
		if (focusedSecretIndex > 0) {
			focusedSecretIndex--;
			focusSecretItem(focusedSecretIndex);
		} else {
			// At first secret, blur and return to page level
			const items = document.querySelectorAll('.secret-item');
			if (items[focusedSecretIndex] instanceof HTMLElement) {
				(items[focusedSecretIndex] as HTMLElement).blur();
			}
			focusedSecretIndex = -1;
		}
	}

	if (e.key === "ArrowDown" && focusArea === "list") {
		e.preventDefault();
		if (focusedSecretIndex < secrets.length - 1) {
			focusedSecretIndex++;
			focusSecretItem(focusedSecretIndex);
		} else if (focusedSecretIndex === secrets.length - 1) {
			// At last secret, blur then move to 1Password panel
			const items = document.querySelectorAll('.secret-item');
			if (items[focusedSecretIndex] instanceof HTMLElement) {
				(items[focusedSecretIndex] as HTMLElement).blur();
			}
			focusArea = "1password";
			focusedSecretIndex = -1;
			focusedOnePasswordInput = 0;
			focusOnePasswordInputField(0);
		}
	}

	// Arrow Up from 1Password panel - return to last secret or exit panel
	if (e.key === "ArrowUp" && focusArea === "1password") {
		e.preventDefault();
		if (focusedOnePasswordInput > 0) {
			// Navigate to previous input in 1Password panel
			focusedOnePasswordInput--;
			focusOnePasswordInputField(focusedOnePasswordInput);
		} else if (focusedOnePasswordInput === 0 && secrets.length > 0) {
			// At first input, blur then return to last secret
			if (document.activeElement instanceof HTMLElement) {
				document.activeElement.blur();
			}
			focusArea = "list";
			focusedSecretIndex = secrets.length - 1;
			focusedOnePasswordInput = -1;
			focusSecretItem(focusedSecretIndex);
		} else if (focusedOnePasswordInput === 0 && secrets.length === 0) {
			// No secrets — exit panel and return to sidebar
			if (document.activeElement instanceof HTMLElement) {
				document.activeElement.blur();
			}
			focusArea = "list";
			focusedOnePasswordInput = -1;
			returnToSidebar();
		}
	}

	// Arrow Down in 1Password panel (when panel itself or inputs focused)
	if (e.key === "ArrowDown" && focusArea === "1password") {
		e.preventDefault();
		const targets = getOnePasswordFocusTargets();
		const maxInputIndex = Math.max(0, targets.length - 1);
		if (focusedOnePasswordInput < maxInputIndex) {
			focusedOnePasswordInput++;
			focusOnePasswordInputField(focusedOnePasswordInput);
		}
	}

	// Escape from 1Password panel returns to secrets list (not sidebar)
	if (e.key === "Escape" && focusArea === "1password") {
		e.preventDefault();
		// Blur current element first
		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}
		focusArea = "list";
		focusedSecretIndex = -1;
		focusedOnePasswordInput = -1;
	}

	// Left Arrow returns to sidebar (only when at page level in list area)
	if (e.key === "ArrowLeft" && focusArea === "list" && focusedSecretIndex === -1) {
		e.preventDefault();
		returnToSidebar();
	}
}

function focusSecretItem(index: number): void {
	const items = document.querySelectorAll('.secret-item');
	if (items[index] instanceof HTMLElement) {
		(items[index] as HTMLElement).focus();
	}
}

function getOnePasswordFocusTargets(): HTMLElement[] {
	const panel = document.querySelector('.onepassword-panel');
	if (!panel) return [];
	// Get all focusable elements sorted by data-focus-index, filtering out disabled ones
	const all = panel.querySelectorAll('[data-focus-index]');
	return (Array.from(all) as HTMLElement[])
		.filter((el) => !(el as HTMLButtonElement).disabled)
		.sort((a, b) => {
			const ai = parseInt(a.getAttribute('data-focus-index') ?? '0', 10);
			const bi = parseInt(b.getAttribute('data-focus-index') ?? '0', 10);
			return ai - bi;
		});
}

function focusOnePasswordInputField(index: number): void {
	const targets = getOnePasswordFocusTargets();
	if (targets.length === 0) return;
	const clamped = Math.min(index, targets.length - 1);
	targets[clamped]?.focus();
}

function handleOnePasswordPanelKeydown(e: KeyboardEvent): void {
	// Arrow Up navigates within 1Password or returns to secrets
	if (e.key === "ArrowUp") {
		e.preventDefault();
		if (focusedOnePasswordInput > 0) {
			focusedOnePasswordInput--;
			focusOnePasswordInputField(focusedOnePasswordInput);
		} else if (focusedOnePasswordInput === 0 && secrets.length > 0) {
			// At any input/button, blur then return to last secret
			if (document.activeElement instanceof HTMLElement) {
				document.activeElement.blur();
			}
			focusArea = "list";
			focusedSecretIndex = secrets.length - 1;
			focusedOnePasswordInput = -1;
			focusSecretItem(focusedSecretIndex);
		} else if (focusedOnePasswordInput === 0 && secrets.length === 0) {
			// No secrets — exit panel and return to sidebar
			if (document.activeElement instanceof HTMLElement) {
				document.activeElement.blur();
			}
			focusArea = "list";
			focusedOnePasswordInput = -1;
			returnToSidebar();
		}
	}
	// Arrow Down navigates within 1Password inputs
	if (e.key === "ArrowDown") {
		e.preventDefault();
		const targets = getOnePasswordFocusTargets();
		const maxInputIndex = Math.max(0, targets.length - 1);
		if (focusedOnePasswordInput < maxInputIndex) {
			focusedOnePasswordInput++;
			focusOnePasswordInputField(focusedOnePasswordInput);
		}
	}
	// Escape returns to secrets list (not sidebar)
	if (e.key === "Escape") {
		e.preventDefault();
		// Blur current element first
		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}
		focusArea = "list";
		focusedSecretIndex = -1;
		focusedOnePasswordInput = -1;
	}
	// Tab navigation within 1Password (let browser handle naturally but track state)
	if (e.key === "Tab") {
		const targets = getOnePasswordFocusTargets();
		const maxIdx = Math.max(0, targets.length - 1);
		if (e.shiftKey && focusedOnePasswordInput > 0) {
			focusedOnePasswordInput--;
		} else if (!e.shiftKey && focusedOnePasswordInput < maxIdx) {
			focusedOnePasswordInput++;
		}
		// Don't prevent default - let browser handle tab navigation
	}
}

function handleOnePasswordInputFocus(index: number): void {
	focusedOnePasswordInput = index;
	focusArea = "1password";
}

function handleSecretItemFocus(index: number): void {
	focusedSecretIndex = index;
	focusArea = "list";
}

function handleSecretItemKeydown(e: KeyboardEvent, index: number): void {
	if (e.key === "ArrowDown") {
		e.preventDefault();
		e.stopPropagation();
		if (index < secrets.length - 1) {
			focusedSecretIndex = index + 1;
			focusSecretItem(focusedSecretIndex);
		} else {
			// Move to 1Password panel - blur current then focus first input
			(e.target as HTMLElement).blur();
			focusArea = "1password";
			focusedSecretIndex = -1;
			focusedOnePasswordInput = 0;
			focusOnePasswordInputField(0);
		}
	} else if (e.key === "ArrowUp") {
		e.preventDefault();
		e.stopPropagation();
		if (index > 0) {
			focusedSecretIndex = index - 1;
			focusSecretItem(focusedSecretIndex);
		} else if (index === 0) {
			// At first secret, return to page level
			focusedSecretIndex = -1;
			(e.target as HTMLElement).blur();
		}
	} else if (e.key === "ArrowLeft") {
		e.preventDefault();
		e.stopPropagation();
		focusedSecretIndex = -1;
		(e.target as HTMLElement).blur();
	}
}

onMount(() => {
	fetchSecrets();
	refreshOnePasswordStatus();
});
</script>

<svelte:window onkeydown={handleGlobalKey} />

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
					{#each secrets as name, index}
						<div
							role="listitem"
							tabindex={0}
							class="secret-item flex items-center gap-3 border border-[var(--sig-border-strong)]
								bg-[var(--sig-surface-raised)] px-[var(--space-md)] py-3 rounded-lg
								hover:bg-[var(--sig-surface)] hover:border-[var(--sig-accent)]
								focus-visible:outline focus-visible:outline-2
								focus-visible:outline-[var(--sig-accent)]
								focus-visible:outline-offset-2
								transition-colors cursor-pointer"
							onkeydown={(e) => handleSecretItemKeydown(e, index)}
							onfocus={() => handleSecretItemFocus(index)}
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
				role="group"
				aria-label="1Password settings"
				class="onepassword-panel flex min-h-0 flex-1 flex-col gap-[var(--space-sm)] overflow-hidden
					border border-[var(--sig-border-strong)] bg-[var(--sig-surface-raised)]
					p-[var(--space-md)] rounded-lg
					hover:bg-[var(--sig-surface)] hover:border-[var(--sig-accent)]
					transition-colors"
				onkeydown={handleOnePasswordPanelKeydown}
			>
				<div class="flex items-center justify-between gap-3">
					<div class="sig-label uppercase tracking-[0.08em]">
						1Password
					</div>
					<Button
						variant="outline"
						size="sm"
						class="rounded-lg text-[11px]
							hover:bg-[var(--sig-surface)]
							focus-visible:outline focus-visible:outline-2
							focus-visible:outline-[var(--sig-accent)]
							focus-visible:outline-offset-2"
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
						data-focus-index="0"
						class="rounded-lg border-[var(--sig-border-strong)]
							bg-[var(--sig-surface)] font-[family-name:var(--font-mono)]
							text-[13px] text-[var(--sig-text-bright)]
							hover:border-[var(--sig-accent)]
							focus-visible:outline focus-visible:outline-2
							focus-visible:outline-[var(--sig-accent)]
							focus-visible:outline-offset-2"
						bind:value={onePasswordToken}
						placeholder={onePasswordStatus.connected
							? "Replace service account token"
							: "1Password service account token"}
						onfocus={() => handleOnePasswordInputFocus(0)}
					/>
					<Button
						size="sm"
						data-focus-index="2"

						class="rounded-lg bg-[var(--sig-text-bright)] text-[var(--sig-bg)] text-[11px]
							hover:bg-[var(--sig-text)]
							focus-visible:outline focus-visible:outline-2
							focus-visible:outline-[var(--sig-accent)]
							focus-visible:outline-offset-2"
						onclick={connectOnePasswordAccount}
						disabled={onePasswordConnecting || !onePasswordToken.trim()}
						onfocus={() => handleOnePasswordInputFocus(2)}
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
						data-focus-index="1"

						class="h-8 rounded-lg border-[var(--sig-border-strong)]
							bg-[var(--sig-surface)] font-[family-name:var(--font-mono)]
							text-[12px] text-[var(--sig-text-bright)]
							hover:border-[var(--sig-accent)]
							focus-visible:outline focus-visible:outline-2
							focus-visible:outline-[var(--sig-accent)]
							focus-visible:outline-offset-2"
						bind:value={onePasswordImportOptions.prefix}
						placeholder="OP"
						onfocus={() => handleOnePasswordInputFocus(1)}
					/>
					<label class="text-[12px] text-[var(--sig-text-muted)]"
						for="op-overwrite">Overwrite</label
					>
					<label id="op-overwrite" class="flex items-center gap-2 text-[12px] text-[var(--sig-text-muted)] cursor-pointer">
						<Checkbox
							bind:checked={onePasswordImportOptions.overwrite}
							class="border-[var(--sig-border-strong)] data-[state=checked]:bg-[var(--sig-accent)] data-[state=checked]:border-[var(--sig-accent)]"
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
									text-[var(--sig-text)] hover:bg-[var(--sig-surface)]
									focus-within:bg-[var(--sig-surface)] rounded transition-colors"
							>
								<Checkbox
									checked={selectedVaultIds.includes(vault.id)}
									onCheckedChange={() => toggleVaultSelection(vault.id)}
									class="border-[var(--sig-border-strong)] data-[state=checked]:bg-[var(--sig-accent)] data-[state=checked]:border-[var(--sig-accent)]"
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
						data-focus-index="3"

						class="rounded-lg bg-[var(--sig-text-bright)] text-[var(--sig-bg)] text-[11px]
							hover:bg-[var(--sig-text)]
							focus-visible:outline focus-visible:outline-2
							focus-visible:outline-[var(--sig-accent)]
							focus-visible:outline-offset-2"
						onclick={importFromOnePassword}
						disabled={onePasswordImporting || !onePasswordStatus.connected}
						onfocus={() => handleOnePasswordInputFocus(3)}
					>
						{onePasswordImporting ? "Importing..." : "Import Into Signet"}
					</Button>
					<Button
						variant="outline"
						size="sm"
						data-focus-index="4"

						class="rounded-lg border-[var(--sig-danger)] text-[var(--sig-danger)]
							text-[11px] hover:bg-[var(--sig-danger)] hover:text-[var(--sig-text-bright)]
							focus-visible:outline focus-visible:outline-2
							focus-visible:outline-[var(--sig-accent)]
							focus-visible:outline-offset-2"
						onclick={disconnectOnePasswordAccount}
						disabled={onePasswordDisconnecting || !onePasswordStatus.configured}
						onfocus={() => handleOnePasswordInputFocus(4)}
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
