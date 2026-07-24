import { useEffect, useState } from "react";
import { useTheme } from "next-themes";
import { Monitor, Moon, Sun } from "lucide-react";
import { Button } from "@/components/ui/button";

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
	useEffect(() => setMounted(true), []);

	const current = (ORDER.includes(theme as Theme) ? theme : "system") as Theme;
	const next = ORDER[(ORDER.indexOf(current) + 1) % ORDER.length];
	const Icon = current === "light" ? Sun : current === "dark" ? Moon : Monitor;

	return (
		<Button
			variant="ghost"
			size="icon"
			onClick={() => setTheme(next)}
			aria-label={`Switch theme (current: ${current})`}
			title={`Theme: ${current} → ${next}`}
			className="size-[26px] rounded-[var(--radius)]"
		>
			{mounted ? <Icon className="size-3.5" /> : <Sun className="size-3.5" />}
		</Button>
	);
}
