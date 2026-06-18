declare module "@lucide/svelte/icons/*" {
	import type { Component } from "svelte";

	type IconProps = Record<string, unknown> & { class?: string };
	const icon: Component<IconProps>;
	export default icon;
}
