<script lang="ts">
import FormField from "$lib/components/config/FormField.svelte";
import FormSection from "$lib/components/config/FormSection.svelte";
import { Checkbox } from "$lib/components/ui/checkbox/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { Textarea } from "$lib/components/ui/textarea/index.js";
import { KNOWN_HARNESSES, st } from "$lib/stores/settings.svelte";

function formatDate(raw: unknown): string {
	if (!raw) return "";
	try {
		return new Date(String(raw)).toLocaleString();
	} catch {
		return String(raw);
	}
}

let customHarnessInput = $state("");

function handleAddCustom() {
	st.addCustomHarness(customHarnessInput);
	customHarnessInput = "";
}

function setStr(path: string[]) {
	return (e: Event) => {
		st.aSetStr(path, (e.currentTarget as HTMLInputElement | HTMLTextAreaElement).value);
	};
}

function toggleHarness(h: string) {
	return (v: boolean | string | undefined) => {
		st.toggleHarness(h, !!v);
	};
}
</script>

{#if st.agentFile}
	<FormSection title="Agent" description="Core identity metadata. Created by signet setup, synced to all harnesses on change.">
		<FormField label="Name" description="Display name shown in harness configs and session context.">
			<Input value={st.aStr(["agent", "name"])} oninput={setStr(["agent", "name"])} />
		</FormField>
		<FormField label="Description" description="Short description of the agent's role and purpose.">
			<Textarea rows={3} value={st.aStr(["agent", "description"])} oninput={setStr(["agent", "description"])} />
		</FormField>
		<FormField label="Created" description="ISO 8601 creation timestamp. Read-only.">
			<Input class="text-[var(--sig-text-muted)] cursor-default" readonly value={formatDate(st.get(st.agent, "agent", "created"))} />
		</FormField>
		<FormField label="Updated" description="ISO 8601 last update timestamp. Read-only.">
			<Input class="text-[var(--sig-text-muted)] cursor-default" readonly value={formatDate(st.get(st.agent, "agent", "updated"))} />
		</FormField>
	</FormSection>

	<FormSection title="Harnesses" defaultOpen={false} description="AI platforms to integrate with. The daemon syncs identity files and installs hooks for each active harness.">
		<FormField label="Active harnesses" description="Supported: claude-code, openclaw, opencode. Cursor, windsurf, chatgpt, and gemini are planned.">
			<div class="flex flex-col gap-1.5">
				{#each KNOWN_HARNESSES as h (h)}
					<label class="flex items-center gap-2 font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text)] cursor-pointer">
						<Checkbox checked={st.harnessArray().includes(h)} onCheckedChange={toggleHarness(h)} />
						<span>{h}</span>
					</label>
				{/each}
				{#each st.harnessArray().filter((h) => !KNOWN_HARNESSES.includes(h)) as h (h)}
					<label class="flex items-center gap-2 font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text)] cursor-pointer">
						<Checkbox checked={true} onCheckedChange={() => st.removeCustomHarness(h)} />
						<span>{h} <em class="not-italic text-[9px] text-[var(--sig-text-muted)] border border-[var(--sig-border-strong)] px-1 align-middle ml-1">custom</em></span>
					</label>
				{/each}
			</div>
		</FormField>
		<FormField label="Add custom harness" description="Add a custom harness name for third-party integrations.">
			<div class="flex gap-1.5">
				<Input placeholder="harness-name" bind:value={customHarnessInput} onkeydown={(e) => { if (e.key === "Enter") handleAddCustom(); }} />
				<button class="font-[family-name:var(--font-mono)] text-[10px] tracking-[0.04em] text-[var(--sig-text)] bg-[var(--sig-surface-raised)] border border-[var(--sig-border-strong)] rounded-none px-3 py-1 cursor-pointer whitespace-nowrap transition-colors hover:bg-[var(--sig-border-strong)]" onclick={handleAddCustom}>Add</button>
			</div>
		</FormField>
	</FormSection>
{/if}
