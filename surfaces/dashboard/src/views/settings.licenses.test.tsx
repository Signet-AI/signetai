import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { DASHBOARD_LICENSES } from "@/lib/dashboard-licenses";
import { Window } from "happy-dom";
import { installDashboardDomGlobals } from "@/test/dom-globals";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { LicensesSection } from "@/components/settings/licenses";

let domWindow: Window;
let restoreDomGlobals = () => {};

beforeAll(() => {
	domWindow = new Window();
	restoreDomGlobals = installDashboardDomGlobals(domWindow);
});

afterAll(() => {
	restoreDomGlobals();
	domWindow.close();
});

const EXPECTED_ATTRIBUTIONS: Record<string, { license: string; href: string }> = {
	streamdown: { license: "Apache-2.0", href: "https://github.com/vercel/streamdown" },
	"use-stick-to-bottom": { license: "MIT", href: "https://github.com/samdenty/use-stick-to-bottom" },
	"lucide-react": { license: "ISC", href: "https://github.com/lucide-icons/lucide" },
	"@fontsource/geist-mono": { license: "OFL-1.1", href: "https://github.com/fontsource/font-files" },
	"@fontsource/schibsted-grotesk": { license: "OFL-1.1", href: "https://github.com/fontsource/font-files" },
	"@radix-ui/react-slot": { license: "MIT", href: "https://github.com/radix-ui/primitives" },
	"@shadcn/react": { license: "MIT", href: "https://github.com/shadcn-ui/ui" },
	"@mingcute/react": { license: "Apache-2.0", href: "https://github.com/mingcute-design/mingcute-icons" },
	"class-variance-authority": { license: "Apache-2.0", href: "https://github.com/joe-bell/cva" },
	clsx: { license: "MIT", href: "https://github.com/lukeed/clsx" },
	"next-themes": { license: "MIT", href: "https://github.com/pacocoursey/next-themes" },
	"radix-ui": { license: "MIT", href: "https://github.com/radix-ui/primitives" },
	react: { license: "MIT", href: "https://github.com/facebook/react" },
	"react-dom": { license: "MIT", href: "https://github.com/facebook/react" },
	sonner: { license: "MIT", href: "https://github.com/emilkowalski/sonner" },
	"tailwind-merge": { license: "MIT", href: "https://github.com/dcastil/tailwind-merge" },
	"d3-force": { license: "ISC", href: "https://github.com/d3/d3-force" },
	yaml: { license: "ISC", href: "https://github.com/eemeli/yaml" },
	"@tailwindcss/vite": { license: "MIT", href: "https://github.com/tailwindlabs/tailwindcss" },
	"@types/react": { license: "MIT", href: "https://github.com/DefinitelyTyped/DefinitelyTyped" },
	"@types/react-dom": { license: "MIT", href: "https://github.com/DefinitelyTyped/DefinitelyTyped" },
	"@types/d3-force": { license: "MIT", href: "https://github.com/DefinitelyTyped/DefinitelyTyped" },
	"@types/yaml": { license: "MIT", href: "https://github.com/eemeli/yaml" },
	"@vitejs/plugin-react": { license: "MIT", href: "https://github.com/vitejs/vite-plugin-react" },
	"happy-dom": { license: "MIT", href: "https://github.com/capricorn86/happy-dom" },
	tailwindcss: { license: "MIT", href: "https://github.com/tailwindlabs/tailwindcss" },
	"tw-animate-css": { license: "MIT", href: "https://github.com/Wombosvideo/tw-animate-css" },
	typescript: { license: "Apache-2.0", href: "https://github.com/microsoft/TypeScript" },
	vite: { license: "MIT", href: "https://github.com/vitejs/vite" },
};

function packageNames(): string[] {
	return DASHBOARD_LICENSES.flatMap((entry) => entry.packages.split(" · "));
}

function entryForPackage(packageName: string) {
	return DASHBOARD_LICENSES.find((entry) => entry.packages.split(" · ").includes(packageName));
}

async function mountLicenses(viewportWidth: number): Promise<{
	readonly container: HTMLDivElement;
	readonly unmount: () => Promise<void>;
}> {
	Object.defineProperty(domWindow, "innerWidth", { configurable: true, value: viewportWidth });
	const container = document.createElement("div");
	container.dataset.viewportWidth = String(viewportWidth);
	container.style.width = `${viewportWidth}px`;
	container.style.overflowX = "hidden";
	document.body.appendChild(container);
	const root: Root = createRoot(container);
	await act(async () => {
		root.render(<LicensesSection />);
	});
	return {
		container,
		unmount: async () => {
			await act(async () => {
				root.unmount();
			});
			container.remove();
		},
	};
}

async function inventoryRows(): Promise<Map<string, { range: string; license: string; href: string }>> {
	const inventory = await Bun.file(new URL("../../../../THIRD_PARTY_LICENSES.md", import.meta.url)).text();
	const rows = new Map<string, { range: string; license: string; href: string }>();
	const rowPattern = /^\|\s*`([^`]+)`\s*\|\s*`([^`]+)`\s*\|\s*([^|]+?)\s*\|\s*\[[^\]]+\]\((https?:\/\/[^)]+)\)\s*\|$/gm;
	for (const match of inventory.matchAll(rowPattern)) {
		rows.set(match[1], { range: match[2], license: match[3].trim(), href: match[4] });
	}
	return rows;
}

describe("dashboard license inventory", () => {
	test("covers every external direct package with its resolved upstream attribution", async () => {
		const manifest = await Bun.file(new URL("../../package.json", import.meta.url)).json();
		const manifestPackages = Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
			.filter(([, range]) => typeof range === "string" && !range.startsWith("workspace:"))
			.map(([packageName]) => packageName)
			.sort();

		expect([...new Set(packageNames())].sort()).toEqual(manifestPackages);
		expect(Object.keys(EXPECTED_ATTRIBUTIONS).sort()).toEqual(manifestPackages);
		for (const packageName of manifestPackages) {
			const entry = entryForPackage(packageName);
			expect(entry, packageName).toBeDefined();
			expect(String(entry?.license), packageName).toBe(EXPECTED_ATTRIBUTIONS[packageName].license);
			expect(String(entry?.href), packageName).toBe(EXPECTED_ATTRIBUTIONS[packageName].href);
		}
	});

	test("keeps the Markdown inventory complete and aligned with manifest ranges", async () => {
		const manifest = await Bun.file(new URL("../../package.json", import.meta.url)).json();
		const expectedRanges = Object.fromEntries(
			Object.entries({ ...manifest.dependencies, ...manifest.devDependencies }).filter(
				([, range]) => typeof range === "string" && !range.startsWith("workspace:"),
			),
		);
		const rows = await inventoryRows();

		expect([...rows.keys()].sort()).toEqual(Object.keys(expectedRanges).sort());
		for (const [packageName, range] of Object.entries(expectedRanges)) {
			expect(rows.get(packageName)?.range, packageName).toBe(range);
			const expectedInventoryLicense = packageName.startsWith("@fontsource/")
				? "SIL Open Font License 1.1"
				: EXPECTED_ATTRIBUTIONS[packageName].license;
			expect(rows.get(packageName)?.license, packageName).toBe(expectedInventoryLicense);
			expect(rows.get(packageName)?.href, packageName).toBe(EXPECTED_ATTRIBUTIONS[packageName].href);
		}
	});
});

describe("dashboard Licenses layout", () => {
	test("keeps every card shrinkable at the failing mobile viewport widths", async () => {
		for (const viewportWidth of [280, 320]) {
			const mounted = await mountLicenses(viewportWidth);
			const cards = [...mounted.container.querySelectorAll<HTMLAnchorElement>("a.group")];

			expect(mounted.container.dataset.viewportWidth).toBe(String(viewportWidth));
			expect(cards).toHaveLength(DASHBOARD_LICENSES.length);
			for (const card of cards) {
				expect(card.classList.contains("min-w-0")).toBe(true);
			}

			await mounted.unmount();
		}
	});

	test("preserves safe links and direct-only scope", async () => {
		const licensesSource = await Bun.file(new URL("../components/settings/licenses.tsx", import.meta.url)).text();
		const normalizedLicensesSource = licensesSource.replace(/\s+/g, " ");

		expect(licensesSource).toContain("DASHBOARD_LICENSES.map");
		expect(licensesSource).toContain('target="_blank"');
		expect(licensesSource).toContain('rel="noopener noreferrer"');
		expect(normalizedLicensesSource).toContain("all external direct runtime + build dependencies");
		expect(normalizedLicensesSource).toContain("transitive dependency notices are not included");
		expect(normalizedLicensesSource).not.toContain("copyright notices");
	});
});
