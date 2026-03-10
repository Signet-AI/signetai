<script lang="ts">
import type { Select as SelectPrimitive } from "bits-ui";

const { open = $bindable(false), value = $bindable(), ...restProps }: SelectPrimitive.RootProps = $props();
</script>

<SelectPrimitive.Root bind:open bind:value={value as never} {...restProps} />
