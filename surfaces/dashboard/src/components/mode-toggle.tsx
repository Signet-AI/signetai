import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { BrightnessRegular as Brightness } from "@mingcute/react/core-regular";
import { Button } from "@/components/ui/button";
import { syncDesktopTitleBarTheme } from "@/lib/desktop";

const ORDER = ["system", "light", "dark"] as const;
type Theme = (typeof ORDER)[number];
export function ModeToggle() {
	const { theme, resolvedTheme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);

	useEffect(() => {
		setMounted(true);
	}, []);

	useEffect(() => {
		syncDesktopTitleBarTheme(resolvedTheme);
	}, [resolvedTheme]);

	const current = (ORDER.includes(theme as Theme) ? theme : "system") as Theme;
	const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
	const visibleTheme = mounted ? current : "light";
	const switchTheme = () => {
		document.documentElement.classList.add("sig-theme-switching");
		setTheme(next);
		requestAnimationFrame(() => {
			requestAnimationFrame(() => document.documentElement.classList.remove("sig-theme-switching"));
		});
	};

	return (
		<Button
			variant="ghost"
			size="icon"
			onClick={switchTheme}
			aria-label={`Switch theme (current: ${current})`}
			title={`Theme: ${current} → ${next}`}
			className="sig-sidebar-link sig-theme-control"
		>
			<Brightness className="size-[18px] shrink-0" aria-hidden="true" />
			<span className="sig-sidebar-label" aria-hidden="true">
				Theme <span className="sig-sidebar-value">{visibleTheme}</span>
			</span>
		</Button>
	);
}
