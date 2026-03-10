<script lang="ts">
import type { Dialog as SheetPrimitive } from "bits-ui";

const { ref = $bindable(null), ...restProps }: SheetPrimitive.CloseProps = $props();
</script>

<SheetPrimitive.Close bind:ref data-slot="sheet-close" {...restProps} />
