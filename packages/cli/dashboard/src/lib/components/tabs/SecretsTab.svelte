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
import { Input } from "$lib/components/ui/input/index.js";
import { Checkbox } from "$lib/components/ui/checkbox/index.js";
import { toast } from "$lib/stores/toast.svelte";
import { returnToSidebar } from "$lib/stores/focus.svelte";
import { nav } from "$lib/stores/navigation.svelte";
import { onMount } from "svelte";
import Plus from "@lucide/svelte/icons/plus";
import Trash2 from "@lucide/svelte/icons/trash-2";
import KeyRound from "@lucide/svelte/icons/key-round";
import ChevronDown from "@lucide/svelte/icons/chevron-down";
import ChevronRight from "@lucide/svelte/icons/chevron-right";
import RefreshCw from "@lucide/svelte/icons/refresh-cw";
import Link from "@lucide/svelte/icons/link";
import Unlink from "@lucide/svelte/icons/unlink";
import Import from "@lucide/svelte/icons/import";

let secrets = $state<string[]>([]);
let secretsLoading = $state(false);
let newSecretName = $state("");
let newSecretValue = $state("");
let secretAdding = $state(false);
let secretDeleting = $state<string | null>(null);
let addFormOpen = $state(false);

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
let onePasswordExpanded = $state(false);

let focusedSecretIndex = $state(-1);
let focusArea = $state<"list" | "1password">("list");
let focusedOnePasswordInput = $state(-1);

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
			onePasswordVaults =
				fetchedVaults.length > 0 ? fetchedVaults : onePasswordStatus.vaults;
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
		addFormOpen = false;
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
	toast(
		`Imported ${importedCount} secrets (skipped ${skippedCount}, errors ${errorCount})`,
		"success",
	);
}

// Keyboard navigation
function handleGlobalKey(e: KeyboardEvent) {
	if (nav.activeTab !== "secrets") return;
	if (e.defaultPrevented) return;

	const target = e.target as HTMLElement;
	const isInputFocused =
		target.tagName === "INPUT" ||
		target.tagName === "TEXTAREA" ||
		target.isContentEditable;

	// Escape: close add form or 1password panel first
	if (e.key === "Escape") {
		if (addFormOpen) {
			e.preventDefault();
			addFormOpen = false;
			return;
		}
		if (focusArea === "1password") {
			e.preventDefault();
			if (document.activeElement instanceof HTMLElement) {
				document.activeElement.blur();
			}
			focusArea = "list";
			focusedSecretIndex = -1;
			focusedOnePasswordInput = -1;
			return;
		}
		e.preventDefault();
		returnToSidebar();
		return;
	}

	if (isInputFocused) return;

	// N: open add form
	if ((e.key === "n" || e.key === "N") && !addFormOpen) {
		e.preventDefault();
		addFormOpen = true;
		return;
	}

	// Right Arrow to focus first secret
	if (e.key === "ArrowRight" && focusArea === "list" && focusedSecretIndex === -1) {
		e.preventDefault();
		if (secrets.length > 0) {
			focusedSecretIndex = 0;
			focusSecretItem(0);
		} else {
			focusArea = "1password";
			focusedOnePasswordInput = 0;
			focusOnePasswordInputField(0);
		}
	}

	// Arrow Up/Down to navigate secrets
	if (e.key === "ArrowUp" && focusArea === "list" && focusedSecretIndex >= 0) {
		e.preventDefault();
		if (focusedSecretIndex > 0) {
			focusedSecretIndex--;
			focusSecretItem(focusedSecretIndex);
		} else {
			focusedSecretIndex = -1;
			returnToSidebar();
		}
	}

	if (e.key === "ArrowDown" && focusArea === "list") {
		e.preventDefault();
		if (focusedSecretIndex < secrets.length - 1) {
			focusedSecretIndex++;
			focusSecretItem(focusedSecretIndex);
		} else if (focusedSecretIndex === secrets.length - 1) {
			const items = document.querySelectorAll(".secret-item");
			if (items[focusedSecretIndex] instanceof HTMLElement) {
				(items[focusedSecretIndex] as HTMLElement).blur();
			}
			focusArea = "1password";
			focusedSecretIndex = -1;
			focusedOnePasswordInput = 0;
			focusOnePasswordInputField(0);
		}
	}

	if (e.key === "ArrowUp" && focusArea === "1password") {
		e.preventDefault();
		if (focusedOnePasswordInput > 0) {
			focusedOnePasswordInput--;
			focusOnePasswordInputField(focusedOnePasswordInput);
		} else if (focusedOnePasswordInput === 0 && secrets.length > 0) {
			if (document.activeElement instanceof HTMLElement) {
				document.activeElement.blur();
			}
			focusArea = "list";
			focusedSecretIndex = secrets.length - 1;
			focusedOnePasswordInput = -1;
			focusSecretItem(focusedSecretIndex);
		} else if (focusedOnePasswordInput === 0 && secrets.length === 0) {
			if (document.activeElement instanceof HTMLElement) {
				document.activeElement.blur();
			}
			focusArea = "list";
			focusedOnePasswordInput = -1;
			returnToSidebar();
		}
	}

	if (e.key === "ArrowDown" && focusArea === "1password") {
		e.preventDefault();
		const targets = getOnePasswordFocusTargets();
		const maxInputIndex = Math.max(0, targets.length - 1);
		if (focusedOnePasswordInput < maxInputIndex) {
			focusedOnePasswordInput++;
			focusOnePasswordInputField(focusedOnePasswordInput);
		}
	}

	if (e.key === "ArrowLeft" && focusArea === "list" && focusedSecretIndex === -1) {
		e.preventDefault();
		returnToSidebar();
	}
}

function focusSecretItem(index: number): void {
	const items = document.querySelectorAll(".secret-item");
	if (items[index] instanceof HTMLElement) {
		(items[index] as HTMLElement).focus();
	}
}

function getOnePasswordFocusTargets(): HTMLElement[] {
	const panel = document.querySelector(".onepassword-panel");
	if (!panel) return [];
	const all = panel.querySelectorAll("[data-focus-index]");
	return (Array.from(all) as HTMLElement[])
		.filter((el) => !(el as HTMLButtonElement).disabled)
		.sort((a, b) => {
			const ai = parseInt(a.getAttribute("data-focus-index") ?? "0", 10);
			const bi = parseInt(b.getAttribute("data-focus-index") ?? "0", 10);
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
	if (e.key === "ArrowUp") {
		e.preventDefault();
		if (focusedOnePasswordInput > 0) {
			focusedOnePasswordInput--;
			focusOnePasswordInputField(focusedOnePasswordInput);
		} else if (focusedOnePasswordInput === 0 && secrets.length > 0) {
			if (document.activeElement instanceof HTMLElement) {
				document.activeElement.blur();
			}
			focusArea = "list";
			focusedSecretIndex = secrets.length - 1;
			focusedOnePasswordInput = -1;
			focusSecretItem(focusedSecretIndex);
		} else if (focusedOnePasswordInput === 0 && secrets.length === 0) {
			if (document.activeElement instanceof HTMLElement) {
				document.activeElement.blur();
			}
			focusArea = "list";
			focusedOnePasswordInput = -1;
			returnToSidebar();
		}
	}
	if (e.key === "ArrowDown") {
		e.preventDefault();
		const targets = getOnePasswordFocusTargets();
		const maxInputIndex = Math.max(0, targets.length - 1);
		if (focusedOnePasswordInput < maxInputIndex) {
			focusedOnePasswordInput++;
			focusOnePasswordInputField(focusedOnePasswordInput);
		}
	}
	if (e.key === "Escape") {
		e.preventDefault();
		if (document.activeElement instanceof HTMLElement) {
			document.activeElement.blur();
		}
		focusArea = "list";
		focusedSecretIndex = -1;
		focusedOnePasswordInput = -1;
	}
	if (e.key === "Tab") {
		const targets = getOnePasswordFocusTargets();
		const maxIdx = Math.max(0, targets.length - 1);
		if (e.shiftKey && focusedOnePasswordInput > 0) {
			focusedOnePasswordInput--;
		} else if (!e.shiftKey && focusedOnePasswordInput < maxIdx) {
			focusedOnePasswordInput++;
		}
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
			focusedSecretIndex = -1;
			if (e.target instanceof HTMLElement) {
				e.target.blur();
			}
			returnToSidebar();
		}
	} else if (e.key === "ArrowLeft") {
		e.preventDefault();
		e.stopPropagation();
		focusedSecretIndex = -1;
		if (e.target instanceof HTMLElement) {
			e.target.blur();
		}
		returnToSidebar();
	}
}

let onePasswordStatusLabel = $derived(
	onePasswordStatus.connected
		? "CONNECTED"
		: onePasswordStatus.configured
			? "UNREACHABLE"
			: "NOT CONFIGURED",
);

let onePasswordStatusColor = $derived(
	onePasswordStatus.connected
		? "var(--sig-success)"
		: onePasswordStatus.configured
			? "var(--sig-warning)"
			: "var(--sig-text-muted)",
);

onMount(() => {
	fetchSecrets();
	refreshOnePasswordStatus();
});
</script>

<svelte:window onkeydown={handleGlobalKey} />

<div class="secrets-page">
	<!-- Header -->
	<div class="tab-header">
		<div class="tab-header-left">
			<span class="tab-header-title">SECRETS</span>
			<span class="tab-header-count">{secrets.length} STORED</span>
		</div>
		<button class="new-secret-btn" onclick={() => { addFormOpen = !addFormOpen; }}>
			<Plus class="size-3" />
			<span>ADD SECRET</span>
		</button>
	</div>

	<!-- Add form (collapsible) -->
	{#if addFormOpen}
		<div class="add-form">
			<div class="add-form-row">
				<Input
					type="text"
					class="secrets-add-input"
					bind:value={newSecretName}
					placeholder="SECRET_NAME"
				/>
				<Input
					type="password"
					class="secrets-add-input"
					bind:value={newSecretValue}
					placeholder="value"
				/>
				<button
					class="add-submit"
					onclick={addSecret}
					disabled={secretAdding || !newSecretName.trim() || !newSecretValue.trim()}
				>
					{secretAdding ? "ADDING..." : "ADD"}
				</button>
			</div>
		</div>
	{/if}

	<!-- Main content -->
	<div class="secrets-content">
		<!-- Secrets list panel -->
		<div class="panel">
			<div class="panel-header">
				<span class="panel-pip" style="background: var(--sig-highlight)"></span>
				<span class="panel-label">Stored Secrets</span>
				<span class="panel-count">{secrets.length}</span>
			</div>
			<div class="panel-body">
				{#if secretsLoading}
					<div class="panel-empty">LOADING</div>
				{:else if secrets.length === 0}
					<div class="panel-empty">
						<span>NO SECRETS STORED</span>
						<span class="panel-empty-hint">PRESS N TO ADD ONE</span>
					</div>
				{:else}
					{#each secrets as name, index}
						<!-- svelte-ignore a11y_no_static_element_interactions -->
						<div
							class="secret-item"
							class:secret-item--focused={focusArea === "list" && focusedSecretIndex === index}
							tabindex="0"
							role="listitem"
							onkeydown={(e) => handleSecretItemKeydown(e, index)}
							onfocus={() => handleSecretItemFocus(index)}
						>
							<KeyRound class="secrets-secret-icon" />
							<span class="secret-name">{name}</span>
							<span class="secret-mask">········</span>
							<button
								class="secret-delete"
								onclick={() => removeSecret(name)}
								disabled={secretDeleting === name}
								aria-label={`Delete secret ${name}`}
							>
								{#if secretDeleting === name}
									<span class="secret-delete-text">...</span>
								{:else}
									<Trash2 class="size-3" />
								{/if}
							</button>
						</div>
					{/each}
				{/if}
			</div>
		</div>

		<!-- 1Password integration panel -->
		<div class="panel" role="group" aria-label="1Password integration">
			<div class="panel-header-row">
				<button
					class="panel-header panel-header--toggle"
					onclick={() => {
						onePasswordExpanded = !onePasswordExpanded;
						if (!onePasswordExpanded) {
							focusedOnePasswordInput = -1;
							focusArea = "list";
						}
					}}
					aria-expanded={onePasswordExpanded}
				>
					{#if onePasswordExpanded}
						<ChevronDown class="secrets-panel-chevron" />
					{:else}
						<ChevronRight class="secrets-panel-chevron" />
					{/if}
					<span class="panel-label">1Password</span>
					<span class="panel-status" style="color: {onePasswordStatusColor}">
						{onePasswordStatusLabel}
					</span>
				</button>
				<button
					class="panel-action"
					onclick={() => refreshOnePasswordStatus()}
					disabled={onePasswordLoading}
					aria-label="Refresh 1Password status"
				>
					<RefreshCw class={`size-3${onePasswordLoading ? " op-spin" : ""}`} />
				</button>
			</div>

			{#if onePasswordExpanded}
				<div class="onepassword-panel" onkeydown={handleOnePasswordPanelKeydown}>
					<!-- Status message -->
					{#if onePasswordStatus.connected}
						<div class="op-status op-status--ok">
							Connected{#if typeof onePasswordStatus.vaultCount === "number"} · {onePasswordStatus.vaultCount} vaults{/if}
						</div>
					{:else if onePasswordStatus.configured}
						<div class="op-status op-status--warn">
							Token saved but unreachable{#if onePasswordStatus.error} · {onePasswordStatus.error}{/if}
						</div>
					{:else}
						<div class="op-status">
							Connect a 1Password service account to import secrets
						</div>
					{/if}

					<!-- Token input -->
					<div class="op-row">
						<Input
							type="password"
							data-focus-index="0"
							class="secrets-op-input"
							bind:value={onePasswordToken}
							placeholder={onePasswordStatus.connected
								? "Replace service account token"
								: "Service account token"}
							onfocus={() => handleOnePasswordInputFocus(0)}
						/>
						<button
							class="op-btn"
							data-focus-index="2"
							onclick={connectOnePasswordAccount}
							disabled={onePasswordConnecting || !onePasswordToken.trim()}
							onfocus={() => handleOnePasswordInputFocus(2)}
						>
							<Link class="size-3" />
							<span>{onePasswordConnecting ? "..." : onePasswordStatus.connected ? "UPDATE" : "CONNECT"}</span>
						</button>
					</div>

					<!-- Options row -->
					<div class="op-options">
						<div class="op-option">
							<span class="op-option-label">PREFIX</span>
							<Input
								type="text"
								data-focus-index="1"
								class="secrets-op-input-sm"
								bind:value={onePasswordImportOptions.prefix}
								placeholder="OP"
								onfocus={() => handleOnePasswordInputFocus(1)}
							/>
						</div>
						<label class="op-option op-option--check" for="op-overwrite">
							<Checkbox
								id="op-overwrite"
								bind:checked={onePasswordImportOptions.overwrite}
								class="secrets-op-checkbox"
							/>
							<span class="op-option-label">OVERWRITE</span>
						</label>
					</div>

					<!-- Vault selector -->
					{#if onePasswordStatus.connected && onePasswordVaults.length > 0}
						<div class="op-vaults">
							<span class="op-vaults-label">VAULTS</span>
							<div class="op-vault-list">
								{#each onePasswordVaults as vault}
									<label class="op-vault">
										<Checkbox
											checked={selectedVaultIds.includes(vault.id)}
											onCheckedChange={() => toggleVaultSelection(vault.id)}
											class="secrets-op-checkbox"
										/>
										<span class="op-vault-name">{vault.name}</span>
									</label>
								{/each}
							</div>
						</div>
					{:else if onePasswordStatus.connected}
						<div class="op-vaults-empty">NO ACCESSIBLE VAULTS</div>
					{/if}

					<!-- Actions -->
					<div class="op-actions">
						<button
							class="op-btn"
							data-focus-index="3"
							onclick={importFromOnePassword}
							disabled={onePasswordImporting || !onePasswordStatus.connected}
							onfocus={() => handleOnePasswordInputFocus(3)}
						>
							<Import class="size-3" />
							<span>{onePasswordImporting ? "IMPORTING..." : "IMPORT"}</span>
						</button>
						<button
							class="op-btn op-btn--danger"
							data-focus-index="4"
							onclick={disconnectOnePasswordAccount}
							disabled={onePasswordDisconnecting || !onePasswordStatus.configured}
							onfocus={() => handleOnePasswordInputFocus(4)}
						>
							<Unlink class="size-3" />
							<span>{onePasswordDisconnecting ? "..." : "DISCONNECT"}</span>
						</button>
					</div>

					<!-- Tip -->
					<div class="op-tip">
						TIP: MAP DIRECT REFS AS <code>op://vault/item/field</code>
					</div>
				</div>
			{/if}
		</div>
	</div>

	<!-- Shortcut bar -->
	<div class="shortcut-bar">
		{#if !addFormOpen}
			<span class="shortcut"><kbd>N</kbd> ADD</span>
		{:else}
			<span class="shortcut"><kbd>ESC</kbd> CANCEL</span>
		{/if}
	</div>
</div>

<style>
	.secrets-page {
		display: flex;
		flex-direction: column;
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	/* Header — matches Tasks */
	.tab-header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		padding: var(--space-sm) var(--space-md);
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.tab-header-left {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
	}

	.tab-header-title {
		font-family: var(--font-display);
		font-size: 11px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-bright);
	}

	.tab-header-count {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}

	.new-secret-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 3px 10px;
		background: transparent;
		border: 1px solid var(--sig-border-strong);
		border-radius: var(--radius);
		color: var(--sig-text-muted);
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.06em;
		cursor: pointer;
		transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
	}

	.new-secret-btn:hover {
		color: var(--sig-highlight);
		border-color: var(--sig-highlight);
	}

	/* Add form */
	.add-form {
		padding: var(--space-sm) var(--space-md);
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.add-form-row {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
	}

	:global(.secrets-add-input) {
		flex: 1;
		font-family: var(--font-mono) !important;
		font-size: 11px !important;
		background: var(--sig-surface) !important;
		border-color: var(--sig-border) !important;
		color: var(--sig-text-bright) !important;
		height: 28px !important;
	}

	:global(.secrets-add-input:focus) {
		border-color: var(--sig-highlight) !important;
	}

	.add-submit {
		padding: 4px 12px;
		height: 28px;
		background: transparent;
		border: 1px solid var(--sig-border-strong);
		border-radius: var(--radius);
		color: var(--sig-text-muted);
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.06em;
		cursor: pointer;
		transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
		white-space: nowrap;
	}

	.add-submit:hover:not(:disabled) {
		color: var(--sig-highlight);
		border-color: var(--sig-highlight);
	}

	.add-submit:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}

	/* Content area */
	.secrets-content {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		padding: var(--space-sm);
		flex: 1;
		min-height: 0;
		overflow: hidden;
	}

	/* Panel — matches TaskBoard columns */
	.panel {
		display: flex;
		flex-direction: column;
		min-height: 0;
		border: 1px solid var(--sig-border);
		border-radius: var(--radius);
		overflow: hidden;
		background: var(--sig-surface);
	}

	.panel:first-child {
		flex: 1;
	}

	.panel:last-child {
		flex-shrink: 0;
	}

	.panel-header {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: var(--space-sm) var(--space-md);
		border-bottom: 1px solid var(--sig-border);
		flex-shrink: 0;
	}

	.panel-header-row {
		display: flex;
		align-items: center;
	}

	.panel-header--toggle {
		flex: 1;
		cursor: pointer;
		background: none;
		border: none;
		text-align: left;
		transition: background var(--dur) var(--ease);
	}

	.panel-header--toggle:hover {
		background: var(--sig-surface-raised);
	}

	:global(.op-spin) {
		animation: spin 1s linear infinite;
	}

	@media (prefers-reduced-motion: reduce) {
		:global(.op-spin) {
			animation: none;
		}
	}

	.panel-pip {
		display: inline-block;
		width: 4px;
		height: 4px;
		flex-shrink: 0;
		border-radius: 50%;
	}

	:global(.secrets-panel-chevron) {
		width: 12px;
		height: 12px;
		flex-shrink: 0;
		color: var(--sig-text-muted);
	}

	.panel-label {
		font-family: var(--font-display);
		font-size: 10px;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.1em;
		color: var(--sig-text-muted);
	}

	.panel-count {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		margin-left: auto;
		font-variant-numeric: tabular-nums;
	}

	.panel-status {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.08em;
		margin-left: auto;
	}

	.panel-action {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		background: none;
		border: none;
		color: var(--sig-text-muted);
		cursor: pointer;
		border-radius: 2px;
		transition: color var(--dur) var(--ease);
		flex-shrink: 0;
	}

	.panel-action:hover {
		color: var(--sig-highlight);
	}

	.panel-body {
		display: flex;
		flex-direction: column;
		overflow-y: auto;
		min-height: 0;
		flex: 1;
	}

	.panel-empty {
		display: flex;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: 4px;
		padding: var(--space-lg) var(--space-md);
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
		opacity: 0.4;
	}

	.panel-empty-hint {
		font-size: 8px;
		opacity: 0.7;
	}

	/* Secret items — flat list like TaskCard */
	.secret-item {
		display: flex;
		align-items: center;
		gap: 8px;
		padding: var(--space-sm) var(--space-md);
		background: transparent;
		border-bottom: 1px solid var(--sig-border);
		cursor: pointer;
		outline: none;
		transition: background var(--dur) var(--ease);
	}

	.secret-item:last-child {
		border-bottom: none;
	}

	.secret-item:hover {
		background: var(--sig-surface-raised);
	}

	.secret-item:focus-visible,
	.secret-item--focused {
		background: var(--sig-surface-raised);
		border-left: 2px solid var(--sig-highlight);
	}

	:global(.secrets-secret-icon) {
		width: 12px;
		height: 12px;
		color: var(--sig-highlight);
		opacity: 0.4;
		flex-shrink: 0;
	}

	.secret-name {
		font-family: var(--font-mono);
		font-size: 11px;
		font-weight: 600;
		color: var(--sig-text-bright);
		flex: 1;
		min-width: 0;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
	}

	.secret-mask {
		font-family: var(--font-mono);
		font-size: 9px;
		color: var(--sig-text-muted);
		letter-spacing: 0.1em;
		flex-shrink: 0;
	}

	.secret-delete {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 22px;
		height: 22px;
		background: none;
		border: none;
		color: var(--sig-text-muted);
		cursor: pointer;
		border-radius: 2px;
		transition: color var(--dur) var(--ease), background var(--dur) var(--ease);
		flex-shrink: 0;
	}

	.secret-delete:hover:not(:disabled) {
		color: var(--sig-danger);
		background: var(--sig-surface-raised);
	}

	.secret-delete:disabled {
		opacity: 0.3;
	}

	.secret-delete-text {
		font-family: var(--font-mono);
		font-size: 9px;
	}

	/* 1Password panel content */
	.onepassword-panel {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
		padding: var(--space-sm) var(--space-md) var(--space-md);
	}

	.op-status {
		font-family: var(--font-mono);
		font-size: 9px;
		letter-spacing: 0.04em;
		color: var(--sig-text-muted);
	}

	.op-status--ok {
		color: var(--sig-success);
	}

	.op-status--warn {
		color: var(--sig-warning, #d4a017);
	}

	.op-row {
		display: flex;
		gap: var(--space-sm);
		align-items: center;
	}

	:global(.secrets-op-input) {
		flex: 1;
		font-family: var(--font-mono) !important;
		font-size: 11px !important;
		background: var(--sig-bg) !important;
		border-color: var(--sig-border) !important;
		color: var(--sig-text-bright) !important;
		height: 28px !important;
	}

	:global(.secrets-op-input:focus),
	:global(.secrets-op-input-sm:focus) {
		border-color: var(--sig-highlight) !important;
	}

	.op-btn {
		display: flex;
		align-items: center;
		gap: 4px;
		padding: 4px 10px;
		height: 28px;
		background: transparent;
		border: 1px solid var(--sig-border-strong);
		border-radius: var(--radius);
		color: var(--sig-text-muted);
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.06em;
		cursor: pointer;
		transition: color var(--dur) var(--ease), border-color var(--dur) var(--ease);
		white-space: nowrap;
		flex-shrink: 0;
	}

	.op-btn:hover:not(:disabled) {
		color: var(--sig-highlight);
		border-color: var(--sig-highlight);
	}

	.op-btn:disabled {
		opacity: 0.3;
		cursor: not-allowed;
	}

	.op-btn--danger:hover:not(:disabled) {
		color: var(--sig-danger);
		border-color: var(--sig-danger);
	}

	/* Options row */
	.op-options {
		display: flex;
		align-items: center;
		gap: var(--space-md);
	}

	.op-option {
		display: flex;
		align-items: center;
		gap: 6px;
	}

	.op-option--check {
		cursor: pointer;
	}

	.op-option-label {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
	}

	:global(.secrets-op-input-sm) {
		width: 60px !important;
		font-family: var(--font-mono) !important;
		font-size: 10px !important;
		background: var(--sig-bg) !important;
		border-color: var(--sig-border) !important;
		color: var(--sig-text-bright) !important;
		height: 24px !important;
	}

	:global(.secrets-op-checkbox) {
		width: 14px !important;
		height: 14px !important;
		border-color: var(--sig-border-strong) !important;
	}

	/* Vault selector */
	.op-vaults {
		display: flex;
		flex-direction: column;
		gap: 4px;
	}

	.op-vaults-label {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
	}

	.op-vault-list {
		display: flex;
		flex-direction: column;
		gap: 2px;
		padding: 4px;
		border: 1px solid var(--sig-border);
		border-radius: var(--radius);
		max-height: 120px;
		overflow-y: auto;
	}

	.op-vault {
		display: flex;
		align-items: center;
		gap: 6px;
		padding: 2px 4px;
		border-radius: 2px;
		cursor: pointer;
		transition: background var(--dur) var(--ease);
	}

	.op-vault:hover {
		background: var(--sig-surface-raised);
	}

	.op-vault-name {
		font-family: var(--font-mono);
		font-size: 10px;
		color: var(--sig-text);
	}

	.op-vaults-empty {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.08em;
		color: var(--sig-text-muted);
		opacity: 0.4;
		padding: 4px 0;
	}

	/* Actions row */
	.op-actions {
		display: flex;
		gap: var(--space-sm);
	}

	/* Tip */
	.op-tip {
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
		opacity: 0.5;
	}

	.op-tip code {
		color: var(--sig-text);
		opacity: 1;
	}

	/* Shortcut bar — matches Tasks */
	.shortcut-bar {
		display: flex;
		align-items: center;
		gap: 12px;
		height: 22px;
		padding: 0 12px;
		border-top: 1px solid var(--sig-border);
		flex-shrink: 0;
		font-family: var(--font-mono);
		font-size: 8px;
		letter-spacing: 0.06em;
		color: var(--sig-text-muted);
	}

	.shortcut {
		display: flex;
		align-items: center;
		gap: 4px;
	}

	.shortcut kbd {
		font-family: var(--font-mono);
		font-size: 8px;
		padding: 0 3px;
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border);
		border-radius: 2px;
		color: var(--sig-text-muted);
	}

	@keyframes spin {
		from { transform: rotate(0deg); }
		to { transform: rotate(360deg); }
	}

	@media (max-width: 1023px) {
		:global(:has(.mobile-sidebar-trigger)) .tab-header {
			padding-left: 6.5rem;
		}
	}
</style>
