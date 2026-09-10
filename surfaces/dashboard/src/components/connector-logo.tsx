import { Link2 } from "@/components/mingcute-icons";
import { useState } from "react";

/**
 * Render a connector's bundled brand mark without making the dashboard aware
 * of which connectors exist. The daemon supplies the asset filename from the
 * connector implementation; an absent or unavailable asset gets a quiet
 * generic fallback.
 */
export function ConnectorLogo({ icon, className }: { icon: string | null; className?: string }) {
	const src = icon ? `/logos/${icon}` : null;
	const [failedSrc, setFailedSrc] = useState<string | null>(null);

	if (!src || failedSrc === src) return <Link2 className={className} aria-hidden="true" />;
	return <img src={src} alt="" aria-hidden="true" className={className} onError={() => setFailedSrc(src)} />;
}
