<script lang="ts">
import FormField from "$lib/components/config/FormField.svelte";
import FormSection from "$lib/components/config/FormSection.svelte";
import { Checkbox } from "$lib/components/ui/checkbox/index.js";
import { Input } from "$lib/components/ui/input/index.js";
import { Textarea } from "$lib/components/ui/textarea/index.js";
import { st, KNOWN_HARNESSES } from "$lib/stores/settings.svelte";

let customHarnessInput = $state("");

function formatDate(raw: unknown): string {
	if (!raw) return "";
	try {
		return new Date(String(raw)).toLocaleString();
	} catch {
		return String(raw);
	}
}

function setStr(path: string[]) {
	return (e: Event) => {
		st.aSetStr(path, (e.currentTarget as HTMLInputElement | HTMLTextAreaElement).value);
	};
}

function handleAddCustom(): void {
	st.addCustomHarness(customHarnessInput);
	customHarnessInput = "";
}
</script>

{#if st.agentFile}
	<FormSection description="Core identity metadata and harness configuration. Created by signet setup, synced to all active harnesses on change.">
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

		<FormField label="Active harnesses" description="Supported: claude-code, codex, openclaw, opencode. Cursor, windsurf, chatgpt, and gemini are planned.">
			<div class="harness-grid">
				{#each KNOWN_HARNESSES as h (h)}
					<label class="harness-item">
						<Checkbox checked={st.harnessArray().includes(h)} onCheckedChange={(v: boolean | string) => st.toggleHarness(h, !!v)} />
						<span class="harness-name">{h}</span>
					</label>
				{/each}
				{#each st.harnessArray().filter((h) => !KNOWN_HARNESSES.includes(h)) as h (h)}
					<label class="harness-item">
						<Checkbox checked={true} onCheckedChange={() => st.removeCustomHarness(h)} />
						<span class="harness-name">{h}</span>
						<span class="harness-badge">custom</span>
					</label>
				{/each}
			</div>
		</FormField>
		<FormField label="Add custom harness" description="Add a custom harness name for third-party integrations." layout="vertical">
			<div class="add-harness">
				<Input placeholder="harness-name" bind:value={customHarnessInput} onkeydown={(e) => { if (e.key === "Enter") handleAddCustom(); }} />
				<button type="button" class="add-btn" onclick={handleAddCustom}>Add</button>
			</div>
		</FormField>
	</FormSection>
{/if}

<style>
	.harness-grid {
		display: flex;
		flex-direction: column;
		gap: var(--space-sm);
	}

	.harness-item {
		display: flex;
		align-items: center;
		gap: var(--space-sm);
		font-family: var(--font-mono);
		font-size: 11px;
		color: var(--sig-text);
		cursor: pointer;
	}

	.harness-name {
		flex: 1;
	}

	.harness-badge {
		font-style: normal;
		font-size: 9px;
		color: var(--sig-text-muted);
		border: 1px solid var(--sig-border-strong);
		padding: 0 var(--space-xs);
	}

	.add-harness {
		display: flex;
		gap: var(--space-sm);
	}

	.add-btn {
		font-family: var(--font-mono);
		font-size: 10px;
		letter-spacing: 0.04em;
		text-transform: uppercase;
		color: var(--sig-text);
		background: var(--sig-surface-raised);
		border: 1px solid var(--sig-border-strong);
		padding: 0 var(--space-md);
		cursor: pointer;
		white-space: nowrap;
		transition: background 0.15s ease;
	}

	.add-btn:hover {
		background: var(--sig-border-strong);
	}
</style>
