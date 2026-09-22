import { Link2 } from "@/components/mingcute-icons";
import { useState } from "react";
export function ConnectorLogo({ icon, className }: { icon: string | null; className?: string }) {
	const baseUrl = import.meta.env.BASE_URL || "/";
	const src = icon ? `${baseUrl}logos/${icon}` : null;
	const [failedSrc, setFailedSrc] = useState<string | null>(null);

	if (!src || failedSrc === src) return <Link2 className={className} aria-hidden="true" />;
	return <img src={src} alt="" aria-hidden="true" className={className} onError={() => setFailedSrc(src)} />;
}
