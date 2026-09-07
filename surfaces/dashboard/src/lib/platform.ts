/**
 * Platform detection for platform-aware dashboard spacing.
 * Native window controls are owned by Electron desktop shells; browser
 * surfaces render the dashboard without window controls.
 */
export type Platform = "mac" | "win" | "linux";

export function detectPlatform(): Platform {
	if (typeof navigator === "undefined") return "mac";
	const ua = navigator.userAgent.toLowerCase();
	const navPlatform = (
		(navigator as Navigator & { userAgentData?: { platform?: string } }).userAgentData?.platform ||
		navigator.platform ||
		""
	).toLowerCase();
	if (ua.includes("mac") || navPlatform.includes("mac")) return "mac";
	if (ua.includes("win") || navPlatform.includes("win")) return "win";
	if (ua.includes("linux") || navPlatform.includes("linux")) return "linux";
	return "mac";
}
