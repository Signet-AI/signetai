import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "@/components/mingcute-icons";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

const ORDER = ["system", "light", "dark"] as const;
type Theme = (typeof ORDER)[number];

/**
 * Theme cycle button in the account row. Cycles system → light → dark, matching
 * the mockup's single-toggle behavior (which flipped dark ⇄ light; we add the
 * system default the issue mandates).
 */
export function ModeToggle() {
	const { theme, setTheme } = useTheme();
	const [mounted, setMounted] = useState(false);
	const [transitionReady, setTransitionReady] = useState(false);

	useEffect(() => {
		setMounted(true);
		let secondFrame = 0;
		const firstFrame = requestAnimationFrame(() => {
			secondFrame = requestAnimationFrame(() => setTransitionReady(true));
		});
		return () => {
			cancelAnimationFrame(firstFrame);
			cancelAnimationFrame(secondFrame);
		};
	}, []);

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
			className="sig-header-control size-[26px] rounded-[var(--radius)]"
		>
			<span className="sig-theme-icon-stack" data-ready={transitionReady} aria-hidden="true">
				<Sun className={cn("sig-theme-icon", visibleTheme === "light" && "is-active")} />
				<Moon className={cn("sig-theme-icon", visibleTheme === "dark" && "is-active")} />
				<Monitor className={cn("sig-theme-icon", visibleTheme === "system" && "is-active")} />
			</span>
		</Button>
	);
}
