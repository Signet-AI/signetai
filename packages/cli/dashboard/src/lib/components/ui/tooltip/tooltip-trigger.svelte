<script lang="ts">
import type { Tooltip as TooltipPrimitive } from "bits-ui";

const { ref = $bindable(null), ...restProps }: TooltipPrimitive.TriggerProps = $props();
</script>

<TooltipPrimitive.Trigger bind:ref data-slot="tooltip-trigger" {...restProps} />
