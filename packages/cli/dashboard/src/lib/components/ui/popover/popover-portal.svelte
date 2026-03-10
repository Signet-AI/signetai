<script lang="ts">
import type { Popover as PopoverPrimitive } from "bits-ui";

const { ...restProps }: PopoverPrimitive.PortalProps = $props();
</script>

<PopoverPrimitive.Portal {...restProps} />
