import type { Window as HappyWindow } from "happy-dom";

const DOM_GLOBALS = [
	"window",
	"document",
	"location",
	"history",
	"navigator",
	"Element",
	"Node",
	"NodeFilter",
	"Text",
	"Document",
	"DocumentFragment",
	"HTMLElement",
	"HTMLAnchorElement",
	"HTMLButtonElement",
	"HTMLFormElement",
	"HTMLImageElement",
	"HTMLInputElement",
	"HTMLSelectElement",
	"HTMLTextAreaElement",
	"HTMLUListElement",
	"SVGElement",
	"Event",
	"CustomEvent",
	"MouseEvent",
	"KeyboardEvent",
	"FocusEvent",
	"PointerEvent",
	"File",
	"FileList",
	"FileReader",
	"FormData",
	"DataTransfer",
	"DOMParser",
	"MutationObserver",
	"localStorage",
	"sessionStorage",
	"getComputedStyle",
	"requestAnimationFrame",
	"cancelAnimationFrame",
] as const;

export function installDashboardDomGlobals(dom: HappyWindow): () => void {
	const names = [...DOM_GLOBALS, "IS_REACT_ACT_ENVIRONMENT"] as const;
	const previous = new Map<string, PropertyDescriptor | undefined>();
	for (const name of names) previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));

	for (const name of DOM_GLOBALS) {
		const value =
			name === "window"
				? dom
				: name === "document"
					? dom.document
					: name === "getComputedStyle" || name === "requestAnimationFrame" || name === "cancelAnimationFrame"
						? Reflect.get(dom, name).bind(dom)
						: Reflect.get(dom, name);
		if (value === undefined) continue;
		Object.defineProperty(globalThis, name, {
			configurable: true,
			enumerable: previous.get(name)?.enumerable ?? false,
			writable: true,
			value,
		});
	}
	Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
		configurable: true,
		enumerable: previous.get("IS_REACT_ACT_ENVIRONMENT")?.enumerable ?? false,
		writable: true,
		value: true,
	});

	let restored = false;
	return () => {
		if (restored) return;
		restored = true;
		for (const name of [...names].reverse()) {
			const descriptor = previous.get(name);
			if (descriptor) Object.defineProperty(globalThis, name, descriptor);
			else Reflect.deleteProperty(globalThis, name);
		}
	};
}
