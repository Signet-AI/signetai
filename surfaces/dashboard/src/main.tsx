import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import { detectPlatform } from "@/lib/platform";
import { ViewProvider } from "@/lib/view-context";
import { App } from "@/app";
import "@fontsource/geist/300.css";
import "@fontsource/geist/400.css";
import "@fontsource/geist/500.css";
import "@fontsource/geist/600.css";
import "@fontsource/geist/700.css";
import "@fontsource/geist-mono/400.css";
import "@fontsource/geist-mono/500.css";
import "@/index.css";

const root = document.getElementById("root");
if (!root) throw new Error("#root not found");

document.documentElement.dataset.platform = detectPlatform();
document.documentElement.dataset.surface = window.signetDesktop ? "desktop" : "web";

createRoot(root).render(
	<StrictMode>
		<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
			<ViewProvider>
				<App />
			</ViewProvider>
		</ThemeProvider>
	</StrictMode>,
);
