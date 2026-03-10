<script lang="ts">
import type { Popover as PopoverPrimitive } from "bits-ui";

const { open = $bindable(false), ...restProps }: PopoverPrimitive.RootProps = $props();
</script>

<PopoverPrimitive.Root bind:open {...restProps} />
