<script lang="ts">
import type { Collapsible as CollapsiblePrimitive } from "bits-ui";

const { ref = $bindable(null), ...restProps }: CollapsiblePrimitive.ContentProps = $props();
</script>

<CollapsiblePrimitive.Content bind:ref data-slot="collapsible-content" {...restProps} />
