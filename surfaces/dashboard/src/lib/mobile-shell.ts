import { useEffect, useState } from "react";

/**
 * Browser zoom can make a desktop CSS viewport appear narrow. The compact shell
 * is therefore reserved for an actually touch-oriented narrow viewport, rather
 * than width alone.
 */
export const MOBILE_SHELL_MEDIA = "(max-width: 639px) and (hover: none) and (pointer: coarse)";

export function useMobileShell(): boolean {
	const [mobileShell, setMobileShell] = useState(() => {
		return typeof window !== "undefined" && window.matchMedia(MOBILE_SHELL_MEDIA).matches;
	});

	useEffect(() => {
		const query = window.matchMedia(MOBILE_SHELL_MEDIA);
		const update = () => setMobileShell(query.matches);
		update();
		query.addEventListener("change", update);
		return () => query.removeEventListener("change", update);
	}, []);

	return mobileShell;
}
