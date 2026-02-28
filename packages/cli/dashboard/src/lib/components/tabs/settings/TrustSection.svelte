<script lang="ts">
import FormField from "$lib/components/config/FormField.svelte";
import FormSection from "$lib/components/config/FormSection.svelte";
import { Input } from "$lib/components/ui/input/index.js";
import * as Select from "$lib/components/ui/select/index.js";
import { st } from "$lib/stores/settings.svelte";

const selectTriggerClass =
	"font-[family-name:var(--font-mono)] text-[11px] text-[var(--sig-text)] bg-[var(--sig-bg)] border-[var(--sig-border-strong)] rounded-none w-full h-auto min-h-[30px] px-2 py-[5px] box-border focus-visible:border-[var(--sig-accent)]";
const selectContentClass =
	"font-[family-name:var(--font-mono)] text-[11px] bg-[var(--sig-bg)] text-[var(--sig-text)] border-[var(--sig-border-strong)] rounded-none";
const selectItemClass = "font-[family-name:var(--font-mono)] text-[11px] rounded-none";

function setSelect(path: string[]) {
	return (v: string | undefined) => {
		st.aSetStr(path, v ?? "");
	};
}

function setStr(path: string[]) {
	return (e: Event) => {
		st.aSetStr(path, (e.currentTarget as HTMLInputElement).value);
	};
}
</script>

{#if st.agentFile}
	<FormSection title="Trust" defaultOpen={false} description="Identity verification method. Controls how the agent proves its identity to peers and registries.">
		<FormField label="Verification" description="none = local only. erc8128 = wallet-based (recommended). gpg/did = alternative signing. registry = contract-based lookup.">
			<Select.Root
				type="single"
				value={st.aStr(["trust", "verification"])}
				onValueChange={setSelect(["trust", "verification"])}
			>
				<Select.Trigger class={selectTriggerClass}>
					{st.aStr(["trust", "verification"]) || "— select —"}
				</Select.Trigger>
				<Select.Content class={selectContentClass}>
					<Select.Item class={selectItemClass} value="" label="— select —" />
					{#each ["none", "erc8128", "gpg", "did", "registry"] as v (v)}
						<Select.Item class={selectItemClass} value={v} label={v} />
					{/each}
				</Select.Content>
			</Select.Root>
		</FormField>
		{#if st.aStr(["trust", "verification"]) === "registry"}
			<FormField label="Registry URL" description="Registry contract address or ENS name for identity lookups.">
				<Input value={st.aStr(["trust", "registry"])} oninput={setStr(["trust", "registry"])} />
			</FormField>
		{/if}
	</FormSection>
{/if}