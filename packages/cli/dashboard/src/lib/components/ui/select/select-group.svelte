<script lang="ts">
import type { Select as SelectPrimitive } from "bits-ui";

const { ref = $bindable(null), ...restProps }: SelectPrimitive.GroupProps = $props();
</script>

<SelectPrimitive.Group bind:ref data-slot="select-group" {...restProps} />
