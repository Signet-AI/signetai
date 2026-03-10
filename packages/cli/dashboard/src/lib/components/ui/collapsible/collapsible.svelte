<script lang="ts">
import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

const { ref = $bindable(null), open = $bindable(false), ...restProps }: CollapsiblePrimitive.RootProps = $props();
</script>

<CollapsiblePrimitive.Root bind:ref bind:open data-slot="collapsible" {...restProps} />
