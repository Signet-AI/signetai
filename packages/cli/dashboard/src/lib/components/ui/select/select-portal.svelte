<script lang="ts">
import type { Select as SelectPrimitive } from "bits-ui";

const { ...restProps }: SelectPrimitive.PortalProps = $props();
</script>

<SelectPrimitive.Portal {...restProps} />
