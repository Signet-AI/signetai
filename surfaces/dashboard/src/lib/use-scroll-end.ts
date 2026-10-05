import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";

export function useScrollEnd<Element extends HTMLElement>(
	contentKey: unknown,
): { readonly ref: RefObject<Element | null>; readonly atEnd: boolean; readonly onScroll: () => void } {
	const ref = useRef<Element>(null);
	const [atEnd, setAtEnd] = useState(true);
	const onScroll = useCallback(() => {
		const element = ref.current;
		if (element) setAtEnd(element.scrollTop + element.clientHeight >= element.scrollHeight - 2);
	}, []);
	// biome-ignore lint/correctness/useExhaustiveDependencies: re-measure when the rendered content changes.
	useLayoutEffect(onScroll, [onScroll, contentKey]);
	return { ref, atEnd, onScroll };
}
