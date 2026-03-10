<script lang="ts">
import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

const { ref = $bindable(null), ...restProps }: CollapsiblePrimitive.TriggerProps = $props();
</script>

<CollapsiblePrimitive.Trigger bind:ref data-slot="collapsible-trigger" {...restProps} />
