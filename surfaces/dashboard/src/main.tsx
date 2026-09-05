import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ThemeProvider } from "@/components/theme-provider";
import { ViewProvider } from "@/lib/view-context";
import { App } from "@/app";
import { detectPlatform } from "@/lib/platform";
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

// Platform attribute drives platform-aware chrome (traffic lights vs caption
// buttons) and the header's left inset under macOS traffic lights.
document.documentElement.dataset.platform = detectPlatform();

createRoot(root).render(
	<StrictMode>
		<ThemeProvider attribute="class" defaultTheme="system" enableSystem disableTransitionOnChange>
			<ViewProvider>
				<App />
			</ViewProvider>
		</ThemeProvider>
	</StrictMode>,
);
