/**
 * Platform detection for platform-aware window chrome.
 * The mockup keys chrome off a `data-platform` attribute (mac | win | linux);
 * mac shows traffic lights, win/linux show caption buttons. In Electron the OS
 * draws the traffic lights; in a browser we render a stand-in for fidelity.
 */
export type Platform = "mac" | "win" | "linux";

export function detectPlatform(): Platform {
	if (typeof navigator === "undefined") return "mac";
	const ua = navigator.userAgent.toLowerCase();
	const navPlatform =
		((navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
			navigator.platform ||
			"").toLowerCase();
	if (ua.includes("mac") || navPlatform.includes("mac")) return "mac";
	if (ua.includes("win") || navPlatform.includes("win")) return "win";
	if (ua.includes("linux") || navPlatform.includes("linux")) return "linux";
	return "mac";
}
