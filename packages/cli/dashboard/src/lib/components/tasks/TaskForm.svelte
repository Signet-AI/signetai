<script lang="ts">
import type { ScheduledTask, CronPreset, Skill } from "$lib/api";
import { getSkills } from "$lib/api";
import { doCreate, doUpdate } from "$lib/stores/tasks.svelte";
import { TASK_PRESETS, type TaskPreset } from "./task-presets";
import * as Sheet from "$lib/components/ui/sheet/index.js";
import { Button } from "$lib/components/ui/button/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { Label } from "$lib/components/ui/label/index.js";
import { Textarea } from "$lib/components/ui/textarea/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import AlertTriangle from "@lucide/svelte/icons/alert-triangle";
import X from "@lucide/svelte/icons/x";

interface Props {
	open: boolean;
	editingId: string | null;
	tasks: ScheduledTask[];
	presets: CronPreset[];
	onclose: () => void;
}

let { open, editingId, tasks, presets, onclose }: Props = $props();

let editing = $derived(editingId ? tasks.find((t) => t.id === editingId) : null);

let name = $state("");
let prompt = $state("");
let cronExpression = $state("0 9 * * *");
let harness = $state<"claude-code" | "opencode">("claude-code");
let workingDirectory = $state("");
let cronMode = $state<"preset" | "custom">("preset");
let submitting = $state(false);

// Skill fields
let skillName = $state<string>("");
let skillMode = $state<"inject" | "slash">("inject");
let installedSkills = $state<Skill[]>([]);

// Task presets
let showPresets = $state(true);

// Hardcoded fallback presets in case API hasn't loaded them yet
const defaultPresets: CronPreset[] = [
	{ label: "Every 15 min", expression: "*/15 * * * *" },
	{ label: "Hourly", expression: "0 * * * *" },
	{ label: "Daily 9am", expression: "0 9 * * *" },
	{ label: "Weekly Mon 9am", expression: "0 9 * * 1" },
];

let activePresets = $derived(presets.length > 0 ? presets : defaultPresets);

function presetLabel(expr: string): string {
	const match = activePresets.find((p) => p.expression === expr);
	return match ? match.label : expr;
}

// Track the last initialized task to prevent re-initialization on auto-refresh
// Use undefined as sentinel to distinguish from null (new task)
let lastInitializedId = $state<string | null | undefined>(undefined);

// Initialize form state only when opening or switching tasks
$effect(() => {
	// Only initialize when:
	// 1. Form just opened (open is true)
	// 2. editingId changed (different task being edited)
	if (open && (lastInitializedId === undefined || editingId !== lastInitializedId)) {
		if (editing) {
			name = editing.name;
			prompt = editing.prompt;
			cronExpression = editing.cron_expression;
			harness = editing.harness;
			workingDirectory = editing.working_directory ?? "";
			skillName = editing.skill_name ?? "";
			skillMode = editing.skill_mode ?? "inject";
			const isPreset = activePresets.some((p) => p.expression === cronExpression);
			cronMode = isPreset ? "preset" : "custom";
			showPresets = false;
		} else {
			name = "";
			prompt = "";
			cronExpression = "0 9 * * *";
			harness = "claude-code";
			workingDirectory = "";
			skillName = "";
			skillMode = "inject";
			cronMode = "preset";
			showPresets = true;
		}
		lastInitializedId = editingId;

		// Fetch installed skills
		getSkills().then((skills) => {
			installedSkills = skills;
		});
	}

	// Reset tracking when form closes
	if (!open) {
		lastInitializedId = undefined;
	}
});

function applyPreset(preset: TaskPreset) {
	name = preset.name;
	prompt = preset.prompt;
	harness = preset.harness;
	cronExpression = preset.cronExpression;
	skillName = preset.skillName ?? "";
	skillMode = preset.skillMode ?? "inject";
	const isPreset = activePresets.some((p) => p.expression === cronExpression);
	cronMode = isPreset ? "preset" : "custom";
	showPresets = false;
}

function selectCronPreset(value: string) {
	if (value === "__custom__") {
		cronMode = "custom";
		cronExpression = "";
	} else {
		cronMode = "preset";
		cronExpression = value;
	}
}

async function handleSubmit() {
	if (!name.trim() || !prompt.trim() || !cronExpression.trim()) return;
	submitting = true;

	const resolvedSkillName = skillName || undefined;
	const resolvedSkillMode = resolvedSkillName ? skillMode : undefined;

	if (editingId) {
		const success = await doUpdate(editingId, {
			name: name.trim(),
			prompt: prompt.trim(),
			cronExpression: cronExpression.trim(),
			harness,
			workingDirectory: workingDirectory.trim() || null,
			skillName: resolvedSkillName ?? null,
			skillMode: resolvedSkillMode ?? null,
		});
		if (success) {
			onclose();
		}
	} else {
		const success = await doCreate({
			name: name.trim(),
			prompt: prompt.trim(),
			cronExpression: cronExpression.trim(),
			harness,
			workingDirectory: workingDirectory.trim() || undefined,
			skillName: resolvedSkillName,
			skillMode: resolvedSkillMode,
		});
		if (success) {
			onclose();
		}
	}
	submitting = false;
}

const inputClass = "bg-[var(--sig-surface-raised)] border-[var(--sig-border)] text-[var(--sig-text-bright)] text-[12px] h-8";
const selectContentClass = "bg-[var(--sig-surface-raised)] border-[var(--sig-border)]";
const selectItemClass = "text-[12px] text-[var(--sig-text)]";
</script>

<Sheet.Root {open} onOpenChange={(v) => { if (!v) onclose(); }}>
	<Sheet.Content
		class="bg-[var(--sig-surface)] border-[var(--sig-border)]
			text-[var(--sig-text)] w-[420px] sm:max-w-[420px]"
	>
		<Sheet.Header class="pb-2">
			<Sheet.Title class="text-[var(--sig-text-bright)] text-[14px]">
				{editingId ? "Edit Task" : "New Scheduled Task"}
			</Sheet.Title>
			<Sheet.Description class="text-[var(--sig-text-muted)] text-[11px]">
				{editingId
					? "Modify this scheduled task."
					: "Schedule a recurring prompt to run automatically."}
			</Sheet.Description>
		</Sheet.Header>

		{#if !editingId && showPresets}
			<div class="flex flex-col gap-2 px-4 pb-3">
				<div class="flex items-center justify-between">
					<span class="text-[10px] font-bold uppercase tracking-[0.1em]
						text-[var(--sig-text-muted)] font-[family-name:var(--font-display)]">
						Start from a template
					</span>
					<button
						class="text-[var(--sig-text-muted)] hover:text-[var(--sig-text)]
							transition-colors p-0.5"
						onclick={() => { showPresets = false; }}
					>
						<X class="size-3" />
					</button>
				</div>
				<div class="grid grid-cols-2 gap-1.5">
					{#each TASK_PRESETS as preset (preset.label)}
						<button
							class="flex flex-col gap-0.5 p-2 rounded text-left
								bg-[var(--sig-surface-raised)] border border-[var(--sig-border)]
								hover:border-[var(--sig-text-muted)] transition-colors cursor-pointer"
							onclick={() => applyPreset(preset)}
						>
							<span class="text-[11px] text-[var(--sig-text-bright)]">
								{preset.label}
							</span>
							<span class="text-[9px] text-[var(--sig-text-muted)] leading-[1.4]">
								{preset.description}
							</span>
						</button>
					{/each}
				</div>
			</div>
		{/if}

		<form
			class="flex flex-col gap-3 px-4"
			onsubmit={(e) => { e.preventDefault(); handleSubmit(); }}
		>
			<div class="flex flex-col gap-1">
				<Label class="text-[11px] text-[var(--sig-text-muted)]">Name</Label>
				<Input
					bind:value={name}
					placeholder="e.g. Review open PRs"
					class={inputClass}
				/>
			</div>

			<div class="flex flex-col gap-1">
				<Label class="text-[11px] text-[var(--sig-text-muted)]">Prompt</Label>
				<Textarea
					bind:value={prompt}
					placeholder="What should the agent do?"
					rows={3}
					class="bg-[var(--sig-surface-raised)] border-[var(--sig-border)]
						text-[var(--sig-text-bright)] text-[12px] resize-none"
				/>
			</div>

			<div class="grid grid-cols-2 gap-3">
				<div class="flex flex-col gap-1">
					<Label class="text-[11px] text-[var(--sig-text-muted)]">Harness</Label>
					<Select.Root
						type="single"
						value={harness}
						onValueChange={(v) => { if (v) harness = v as "claude-code" | "opencode"; }}
					>
						<Select.Trigger class="{inputClass} w-full">
							{harness === "claude-code" ? "Claude Code" : "OpenCode"}
						</Select.Trigger>
						<Select.Content class={selectContentClass}>
							<Select.Item value="claude-code" label="Claude Code" class={selectItemClass}>
								Claude Code
							</Select.Item>
							<Select.Item value="opencode" label="OpenCode" class={selectItemClass}>
								OpenCode
							</Select.Item>
						</Select.Content>
					</Select.Root>
				</div>

				<div class="flex flex-col gap-1">
					<Label class="text-[11px] text-[var(--sig-text-muted)]">Schedule</Label>
					<Select.Root
						type="single"
						value={cronMode === "custom" ? "__custom__" : cronExpression}
						onValueChange={selectCronPreset}
					>
						<Select.Trigger class="{inputClass} w-full">
							{cronMode === "custom"
								? "Custom..."
								: presetLabel(cronExpression)}
						</Select.Trigger>
						<Select.Content class={selectContentClass}>
							{#each activePresets as preset (preset.expression)}
								<Select.Item
									value={preset.expression}
									label={preset.label}
									class={selectItemClass}
								>
									<span class="flex items-center justify-between w-full gap-2">
										<span>{preset.label}</span>
										<span class="text-[10px] text-[var(--sig-text-muted)]
											font-[family-name:var(--font-mono)] opacity-60">
											{preset.expression}
										</span>
									</span>
								</Select.Item>
							{/each}
							<Select.Item value="__custom__" label="Custom..." class={selectItemClass}>
								Custom...
							</Select.Item>
						</Select.Content>
					</Select.Root>
				</div>
			</div>

			{#if cronMode === "custom"}
				<div class="flex flex-col gap-1">
					<Label class="text-[11px] text-[var(--sig-text-muted)]">
						Cron expression
					</Label>
					<Input
						bind:value={cronExpression}
						placeholder="*/15 * * * *"
						class="{inputClass} font-[family-name:var(--font-mono)]"
					/>
					<span class="text-[10px] text-[var(--sig-text-muted)] opacity-60">
						minute hour day-of-month month day-of-week
					</span>
				</div>
			{/if}

			<div class="flex flex-col gap-1">
				<Label class="text-[11px] text-[var(--sig-text-muted)]">
					Working directory
					<span class="opacity-50">(optional)</span>
				</Label>
				<Input
					bind:value={workingDirectory}
					placeholder="/path/to/project"
					class="{inputClass} font-[family-name:var(--font-mono)]"
				/>
			</div>

			<div class="flex flex-col gap-1">
				<Label class="text-[11px] text-[var(--sig-text-muted)]">
					Skill
					<span class="opacity-50">(optional)</span>
				</Label>
				<div class="grid gap-2" class:grid-cols-2={skillName}>
					<Select.Root
						type="single"
						value={skillName || "__none__"}
						onValueChange={(v) => {
							if (v === "__none__") {
								skillName = "";
							} else if (v) {
								skillName = v;
							}
						}}
					>
						<Select.Trigger class="{inputClass} w-full">
							{skillName || "None"}
						</Select.Trigger>
						<Select.Content class={selectContentClass}>
							<Select.Item value="__none__" label="None" class={selectItemClass}>
								None
							</Select.Item>
							{#each installedSkills as skill (skill.name)}
								<Select.Item
									value={skill.name}
									label={skill.name}
									class={selectItemClass}
								>
									<span class="flex items-center justify-between w-full gap-2">
										<span>{skill.name}</span>
										{#if skill.description}
											<span class="text-[9px] text-[var(--sig-text-muted)]
												truncate max-w-[140px]">
												{skill.description}
											</span>
										{/if}
									</span>
								</Select.Item>
							{/each}
						</Select.Content>
					</Select.Root>

					{#if skillName}
						<Select.Root
							type="single"
							value={skillMode}
							onValueChange={(v) => { if (v) skillMode = v as "inject" | "slash"; }}
						>
							<Select.Trigger class="{inputClass} w-full">
								{skillMode === "inject" ? "Inject content" : "Slash command"}
							</Select.Trigger>
							<Select.Content class={selectContentClass}>
								<Select.Item value="inject" label="Inject content" class={selectItemClass}>
									Inject content
								</Select.Item>
								<Select.Item value="slash" label="Slash command" class={selectItemClass}>
									Slash command
								</Select.Item>
							</Select.Content>
						</Select.Root>
					{/if}
				</div>
			</div>

			{#if harness === "claude-code"}
				<div
					class="flex gap-2 p-2 rounded
						bg-[var(--sig-warning,#f59e0b)]/8
						border border-[var(--sig-warning,#f59e0b)]/20"
				>
					<AlertTriangle
						class="size-3.5 shrink-0 mt-px text-[var(--sig-warning,#f59e0b)]"
					/>
					<span class="text-[10px] text-[var(--sig-text-muted)] leading-[1.6]">
						Runs with <code
							class="text-[10px] font-[family-name:var(--font-mono)]
								text-[var(--sig-text)] bg-[var(--sig-surface-raised)] px-1 py-px"
						>--dangerously-skip-permissions</code> — no approval gates.
					</span>
				</div>
			{/if}

			<Button
				type="submit"
				disabled={submitting || !name.trim() || !prompt.trim()}
				class="h-8 text-[11px] w-full mt-1"
			>
				{#if submitting}
					{editingId ? "Saving..." : "Creating..."}
				{:else}
					{editingId ? "Save Changes" : "Create Task"}
				{/if}
			</Button>
		</form>
	</Sheet.Content>
</Sheet.Root>
