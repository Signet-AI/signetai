<script lang="ts">
import type { Memory } from "$lib/api";
import {
	doUpdateMemory,
	doDeleteMemory,
	closeEditForm,
} from "$lib/stores/memory.svelte";
import * as Sheet from "$lib/components/ui/sheet/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { Label } from "$lib/components/ui/label/index.js";
import { Textarea } from "$lib/components/ui/textarea/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import { Switch } from "$lib/components/ui/switch/index.js";
import AlertTriangle from "@lucide/svelte/icons/alert-triangle";

interface Props {
	open: boolean;
	editingId: string | null;
	mode: "edit" | "delete" | null;
	memories: Memory[];
	onclose: () => void;
}

let { open, editingId, mode, memories, onclose }: Props = $props();

let editing = $derived(
	editingId ? memories.find((m) => m.id === editingId) ?? null : null,
);

// Form state
let content = $state("");
let type = $state("");
let customType = $state("");
let importance = $state("0.5");
let tags = $state("");
let pinned = $state(false);
let reason = $state("");
let forceDelete = $state(false);
let submitting = $state(false);
let error = $state("");

const knownTypes = [
	"fact",
	"preference",
	"decision",
	"issue",
	"rationale",
	"context",
	"goal",
	"constraint",
	"insight",
	"learning",
] as const;

// Track last initialised ID to avoid re-init on same memory
let lastInitializedId: string | undefined | null = undefined;

$effect(() => {
	if (open && editing) {
		const currentId = editing.id;
		if (currentId !== lastInitializedId) {
			lastInitializedId = currentId;
			content = editing.content ?? "";
			const rawType = editing.type ?? "";
			if (knownTypes.includes(rawType as (typeof knownTypes)[number])) {
				type = rawType;
				customType = "";
			} else if (rawType) {
				type = "__custom__";
				customType = rawType;
			} else {
				type = "";
				customType = "";
			}
			importance = String(editing.importance ?? 0.5);
			tags = normaliseTags(editing.tags);
			pinned = editing.pinned ?? false;
			reason = "";
			forceDelete = false;
			error = "";
		}
	}
	if (!open) {
		lastInitializedId = undefined;
		error = "";
	}
});

function normaliseTags(raw: Memory["tags"]): string {
	if (!raw) return "";
	if (Array.isArray(raw)) return raw.join(", ");
	const trimmed = raw.trim();
	if (trimmed.startsWith("[") && trimmed.endsWith("]")) {
		try {
			const parsed = JSON.parse(trimmed) as unknown;
			if (Array.isArray(parsed)) return parsed.join(", ");
		} catch {
			// fallthrough
		}
	}
	return trimmed;
}

function resolvedType(): string {
	return type === "__custom__" ? customType.trim() : type;
}

async function handleEdit() {
	if (!editingId || !editing) return;
	const trimmedContent = content.trim();
	const trimmedReason = reason.trim();
	if (!trimmedContent) {
		error = "Content cannot be empty.";
		return;
	}
	if (!trimmedReason) {
		error = "Please provide a reason for the change.";
		return;
	}

	submitting = true;
	error = "";

	const parsedImportance = parseFloat(importance);
	const updates: {
		content?: string;
		type?: string;
		importance?: number;
		tags?: string;
		pinned?: boolean;
	} = {};

	if (trimmedContent !== (editing.content ?? "")) {
		updates.content = trimmedContent;
	}
	const newType = resolvedType();
	if (newType !== (editing.type ?? "")) {
		updates.type = newType;
	}
	if (
		Number.isFinite(parsedImportance) &&
		parsedImportance !== (editing.importance ?? 0.5)
	) {
		updates.importance = parsedImportance;
	}
	const newTags = tags.trim();
	const oldTags = normaliseTags(editing.tags);
	if (newTags !== oldTags) {
		updates.tags = newTags;
	}
	if (pinned !== (editing.pinned ?? false)) {
		updates.pinned = pinned;
	}

	if (Object.keys(updates).length === 0) {
		error = "No changes detected.";
		submitting = false;
		return;
	}

	const result = await doUpdateMemory(editingId, updates, trimmedReason);
	submitting = false;

	if (result.success) {
		onclose();
	}

async function handleDelete() {
	if (!editingId) return;
	const trimmedReason = reason.trim();
	if (!trimmedReason) {
		error = "Please provide a reason for deletion.";
		return;
	}

	submitting = true;
	error = "";
	const result = await doDeleteMemory(editingId, trimmedReason, forceDelete);
	submitting = false;

	if (result.success) {
		onclose();
	} else {
		error = result.error ?? "Delete failed.";
	}
}

const inputClass =
	"bg-[var(--sig-surface-raised)] border-[var(--sig-border)] text-[var(--sig-text-bright)] text-[12px] h-8";
const selectContentClass =
	"bg-[var(--sig-surface-raised)] border-[var(--sig-border)]";
const selectItemClass = "text-[12px] text-[var(--sig-text)]";
</script>

<Sheet.Root {open} onOpenChange={(v) => { if (!v) onclose(); }}>
	<Sheet.Content
		class="bg-[var(--sig-surface)] border-[var(--sig-border)]
			text-[var(--sig-text)] w-[420px] sm:max-w-[420px]"
	>
		<Sheet.Header class="pb-2">
			<Sheet.Title class="text-[var(--sig-text-bright)] text-[14px]">
				{mode === "delete" ? "Delete Memory" : "Edit Memory"}
			</Sheet.Title>
			<Sheet.Description class="text-[var(--sig-text-muted)] text-[11px]">
				{mode === "delete"
					? "This will soft-delete the memory. It can be recovered later."
					: "Update this memory's content or metadata."}
			</Sheet.Description>
		</Sheet.Header>

		{#if editing}
			<form
				class="flex flex-col gap-3 px-4"
				onsubmit={(e) => {
					e.preventDefault();
					if (mode === "delete") handleDelete();
					else handleEdit();
				}}
			>
				{#if mode === "edit"}
					<!-- Content -->
					<div class="flex flex-col gap-1">
						<Label class="text-[11px] text-[var(--sig-text-muted)]"
							>Content</Label
						>
						<Textarea
							bind:value={content}
							rows={4}
							class="bg-[var(--sig-surface-raised)] border-[var(--sig-border)]
								text-[var(--sig-text-bright)] text-[12px] resize-none"
						/>
					</div>

					<!-- Type + Importance row -->
					<div class="grid grid-cols-2 gap-3">
						<div class="flex flex-col gap-1">
							<Label class="text-[11px] text-[var(--sig-text-muted)]"
								>Type</Label
							>
							<Select.Root
								type="single"
								value={type}
								onValueChange={(v) => {
									if (v !== undefined && v !== null) type = v;
								}}
							>
								<Select.Trigger class="{inputClass} w-full">
									{type === "__custom__"
										? customType || "Custom..."
										: type || "Select type"}
								</Select.Trigger>
								<Select.Content class={selectContentClass}>
									<Select.Item
										value=""
										label="None"
										class={selectItemClass}
									/>
									{#each knownTypes as t (t)}
										<Select.Item
											value={t}
											label={t}
											class={selectItemClass}>{t}</Select.Item
										>
									{/each}
									<Select.Item
										value="__custom__"
										label="Custom..."
										class={selectItemClass}>Custom...</Select.Item
									>
								</Select.Content>
							</Select.Root>
						</div>

						<div class="flex flex-col gap-1">
							<Label class="text-[11px] text-[var(--sig-text-muted)]"
								>Importance</Label
							>
							<Input
								type="number"
								min="0"
								max="1"
								step="0.05"
								bind:value={importance}
								class="{inputClass} font-[family-name:var(--font-mono)]"
							/>
						</div>
					</div>

					{#if type === "__custom__"}
						<div class="flex flex-col gap-1">
							<Label class="text-[11px] text-[var(--sig-text-muted)]"
								>Custom type</Label
							>
							<Input
								bind:value={customType}
								placeholder="e.g. observation"
								class={inputClass}
							/>
						</div>
					{/if}

					<!-- Tags -->
					<div class="flex flex-col gap-1">
						<Label class="text-[11px] text-[var(--sig-text-muted)]"
							>Tags</Label
						>
						<Input
							bind:value={tags}
							placeholder="Comma-separated (e.g. work, debug)"
							class={inputClass}
						/>
					</div>

					<!-- Pinned -->
					<div class="flex items-center justify-between">
						<Label class="text-[11px] text-[var(--sig-text-muted)]"
							>Pinned</Label
						>
						<Switch bind:checked={pinned} />
					</div>

					<!-- Reason -->
					<div class="flex flex-col gap-1">
						<Label class="text-[11px] text-[var(--sig-text-muted)]"
							>Reason for change
							<span class="text-[var(--sig-accent)]">*</span></Label
						>
						<Textarea
							bind:value={reason}
							placeholder="Why are you editing this memory?"
							rows={2}
							class="bg-[var(--sig-surface-raised)] border-[var(--sig-border)]
								text-[var(--sig-text-bright)] text-[12px] resize-none"
						/>
					</div>
				{:else}
					<!-- DELETE mode: read-only preview -->
					<div
						class="flex flex-col gap-2 p-3 border border-[var(--sig-border-strong)]
							bg-[var(--sig-surface-raised)]"
					>
						<p
							class="m-0 text-[var(--sig-text-bright)] text-[11px]
								leading-[1.5] whitespace-pre-wrap break-words"
						>
							{editing.content}
						</p>
						<div
							class="flex flex-wrap gap-1 text-[9px]
								font-[family-name:var(--font-mono)]
								text-[var(--sig-text-muted)]"
						>
							{#if editing.type}
								<span
									class="px-1.5 py-px border border-[var(--sig-border-strong)]"
									>{editing.type}</span
								>
							{/if}
							<span
								class="px-1.5 py-px border border-[var(--sig-border-strong)]"
								>imp {Math.round((editing.importance ?? 0) * 100)}%</span
							>
							<span
								class="px-1.5 py-px border border-[var(--sig-border-strong)]"
								>{editing.who || "unknown"}</span
							>
						</div>
					</div>

					<!-- Warning -->
					<div
						class="flex gap-2 p-2
							bg-red-500/8 border border-red-500/20"
					>
						<AlertTriangle
							class="size-3.5 shrink-0 mt-px text-red-400"
						/>
						<span
							class="text-[10px] text-[var(--sig-text-muted)] leading-[1.6]"
						>
							{#if pinned}
								This memory is <strong>pinned</strong>. Deleting it requires
								force, which removes it permanently from search results.
							{:else}
								This is a soft delete. The memory will be marked as deleted
								but can be recovered from the database if needed.
							{/if}
						</span>
					</div>

					{#if pinned}
						<!-- Force option for pinned memories -->
						<div class="flex items-center gap-2">
							<Switch bind:checked={forceDelete} />
							<Label class="text-[11px] text-[var(--sig-text-muted)]">
								Force delete pinned memory
							</Label>
						</div>
					{/if}

					<!-- Reason -->
					<div class="flex flex-col gap-1">
						<Label class="text-[11px] text-[var(--sig-text-muted)]"
							>Reason for deletion
							<span class="text-[var(--sig-accent)]">*</span></Label
						>
						<Textarea
							bind:value={reason}
							placeholder="Why should this memory be deleted?"
							rows={2}
							class="bg-[var(--sig-surface-raised)] border-[var(--sig-border)]
								text-[var(--sig-text-bright)] text-[12px] resize-none"
						/>
					</div>
				{/if}

				<!-- Error message -->
				{#if error}
					<p
						class="m-0 text-[11px] text-red-400
							font-[family-name:var(--font-mono)]"
					>
						{error}
					</p>
				{/if}

				<!-- Submit -->
				<Button
					type="submit"
					disabled={submitting || !reason.trim()}
					variant={mode === "delete" ? "destructive" : "default"}
					class="h-8 text-[11px] w-full mt-1"
				>
					{#if submitting}
						{mode === "delete" ? "Deleting..." : "Saving..."}
					{:else}
						{mode === "delete" ? "Delete Memory" : "Save Changes"}
					{/if}
				</Button>
			</form>
		{/if}
	</Sheet.Content>
</Sheet.Root>
