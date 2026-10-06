import { type RefObject, useCallback, useLayoutEffect, useRef, useState } from "react";

export function useScrollEnd<Element extends HTMLElement>(): {
	readonly ref: RefObject<Element | null>;
	readonly atEnd: boolean;
	readonly onScroll: () => void;
} {
	const ref = useRef<Element>(null);
	const [atEnd, setAtEnd] = useState(true);
	const onScroll = useCallback(() => {
		const element = ref.current;
		if (element) setAtEnd(element.scrollTop + element.clientHeight >= element.scrollHeight - 2);
	}, []);
	useLayoutEffect(onScroll);
	return { ref, atEnd, onScroll };
}
