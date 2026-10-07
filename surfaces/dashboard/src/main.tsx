import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import { detectPlatform } from "@/lib/platform";
import { ViewProvider } from "@/lib/view-context";
import { App } from "@/app";
import "@fontsource/schibsted-grotesk/400.css";
import "@fontsource/schibsted-grotesk/500.css";
import "@fontsource/schibsted-grotesk/600.css";
import "@fontsource/schibsted-grotesk/700.css";
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
