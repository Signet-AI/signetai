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

function setNum(path: string[]) {
	return (e: Event) => {
		st.aSetNum(path, (e.currentTarget as HTMLInputElement).value);
	};
}
</script>

{#if st.agentFile}
	<FormSection title="Auth" defaultOpen={false} description="Authentication for the daemon API. Optional — disabled in local mode. Uses HMAC-SHA256 signed tokens.">
		<FormField label="Method" description="Signing method for auth tokens. erc8128 uses wallet signatures, gpg/did use alternative signing.">
			<Select.Root
				type="single"
				value={st.aStr(["auth", "method"])}
				onValueChange={setSelect(["auth", "method"])}
			>
				<Select.Trigger class={selectTriggerClass}>
					{st.aStr(["auth", "method"]) || "— select —"}
				</Select.Trigger>
				<Select.Content class={selectContentClass}>
					<Select.Item class={selectItemClass} value="" label="— select —" />
					{#each ["none", "erc8128", "gpg", "did"] as v (v)}
						<Select.Item class={selectItemClass} value={v} label={v} />
					{/each}
				</Select.Content>
			</Select.Root>
		</FormField>
		<FormField label="Mode" description="local = no auth required (localhost only). team = tokens required for all requests. hybrid = localhost skips auth, remote requires tokens.">
			<Select.Root
				type="single"
				value={st.aStr(["auth", "mode"])}
				onValueChange={setSelect(["auth", "mode"])}
			>
				<Select.Trigger class={selectTriggerClass}>
					{st.aStr(["auth", "mode"]) || "— select —"}
				</Select.Trigger>
				<Select.Content class={selectContentClass}>
					<Select.Item class={selectItemClass} value="" label="— select —" />
					{#each ["local", "team", "hybrid"] as v (v)}
						<Select.Item class={selectItemClass} value={v} label={v} />
					{/each}
				</Select.Content>
			</Select.Root>
		</FormField>
		<FormField label="Chain ID" description="Ethereum chain ID for ERC-8128 signature verification. Default: 1 (mainnet).">
			<Input type="number" value={st.aNum(["auth", "chainId"])} oninput={setNum(["auth", "chainId"])} />
		</FormField>
	</FormSection>
{/if}