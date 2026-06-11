<script lang="ts">
import FormField from "$lib/components/config/FormField.svelte";
import FormSection from "$lib/components/config/FormSection.svelte";
import * as Select from "$lib/components/ui/select/index.js";
import { st } from "$lib/stores/settings.svelte";
// Duplicated from @signet/core/network — core is a Node.js bundle and
// cannot be imported into the browser dashboard build.
const NETWORK_MODES = ["localhost", "tailscale"] as const;

const selectTriggerClass =
	"font-mono text-[11px] text-[var(--sig-text)] bg-[var(--sig-bg)] border-[var(--sig-border-strong)] rounded-lg w-full h-auto min-h-[30px] px-2 py-[5px] box-border focus-visible:border-[var(--sig-accent)]";
const selectContentClass =
	"font-mono text-[11px] bg-[var(--sig-bg)] text-[var(--sig-text)] border-[var(--sig-border-strong)] rounded-lg";
const selectItemClass = "font-mono text-[11px] rounded-lg";
const mode = $derived(st.aStr(["network", "mode"]) || "localhost");
const auth = $derived(st.sStr(["auth", "mode"]) || "local");
const warn = $derived(mode === "tailscale" && auth === "local");

function setMode(value: string | undefined): void {
	st.aSetStr(["network", "mode"], value ?? "localhost");
}

function modeLabel(value: string): string {
	if (value === "tailscale") return "tailscale";
	return "localhost";
}
</script>

{#if st.agentFile}
	<FormSection description="Daemon bind mode. localhost keeps Signet on 127.0.0.1 only. tailscale keeps localhost working and also binds 0.0.0.0 so other devices on your tailnet can reach it. Restart the daemon after saving.">
		<FormField label="Hosting mode" description="If auth.mode is local, anyone on your trusted tailnet can access the dashboard and API when tailscale mode is enabled.">
			<Select.Root
				type="single"
				value={mode}
				onValueChange={setMode}
			>
				<Select.Trigger class={selectTriggerClass}>
					{modeLabel(mode)}
				</Select.Trigger>
				<Select.Content class={selectContentClass}>
					{#each NETWORK_MODES as value (value)}
						<Select.Item class={selectItemClass} value={value} label={modeLabel(value)} />
					{/each}
				</Select.Content>
			</Select.Root>
			{#if warn}
				<div
					class="mt-3 px-3 py-2 text-[10px] font-mono text-[var(--sig-warning,#d4a017)] bg-[color-mix(in_srgb,var(--sig-warning,#d4a017)_10%,transparent)] border border-[var(--sig-warning,#d4a017)]"
				>
					Tailscale mode with local auth exposes the dashboard and API to other devices on your tailnet. Switch auth.mode before saving if you do not want shared access.
				</div>
			{/if}
		</FormField>
	</FormSection>
{/if}
