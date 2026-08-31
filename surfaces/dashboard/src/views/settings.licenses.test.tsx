/** Regression coverage for #1718: the Licenses modal must stay reachable and accurately scoped. */
import { describe, expect, test } from "bun:test";
import { DASHBOARD_LICENSES } from "@/lib/dashboard-licenses";

const EXPECTED_ATTRIBUTIONS: Record<string, { license: string; href: string }> = {
	"@fontsource/geist": { license: "OFL-1.1", href: "https://github.com/fontsource/font-files" },
	"@fontsource/geist-mono": { license: "OFL-1.1", href: "https://github.com/fontsource/font-files" },
	"@radix-ui/react-slot": { license: "MIT", href: "https://github.com/radix-ui/primitives" },
	"@shadcn/react": { license: "MIT", href: "https://github.com/shadcn-ui/ui" },
	"class-variance-authority": { license: "Apache-2.0", href: "https://github.com/joe-bell/cva" },
	clsx: { license: "MIT", href: "https://github.com/lukeed/clsx" },
	"lucide-react": { license: "ISC", href: "https://github.com/lucide-icons/lucide" },
	"next-themes": { license: "MIT", href: "https://github.com/pacocoursey/next-themes" },
	"radix-ui": { license: "MIT", href: "https://github.com/radix-ui/primitives" },
	react: { license: "MIT", href: "https://github.com/facebook/react" },
	"react-dom": { license: "MIT", href: "https://github.com/facebook/react" },
	sonner: { license: "MIT", href: "https://github.com/emilkowalski/sonner" },
	"tailwind-merge": { license: "MIT", href: "https://github.com/dcastil/tailwind-merge" },
	three: { license: "MIT", href: "https://github.com/mrdoob/three.js" },
	yaml: { license: "ISC", href: "https://github.com/eemeli/yaml" },
	"@tailwindcss/vite": { license: "MIT", href: "https://github.com/tailwindlabs/tailwindcss" },
	"@types/react": { license: "MIT", href: "https://github.com/DefinitelyTyped/DefinitelyTyped" },
	"@types/react-dom": { license: "MIT", href: "https://github.com/DefinitelyTyped/DefinitelyTyped" },
	"@types/three": { license: "MIT", href: "https://github.com/DefinitelyTyped/DefinitelyTyped" },
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

describe("dashboard Licenses modal layout", () => {
	test("pins mobile layout, navigation, safe links, and direct-only scope", async () => {
		const source = await Bun.file(new URL("./settings.tsx", import.meta.url)).text();
		const licensesStart = source.indexOf("function LicensesSection()");
		const logsStart = source.indexOf("/* ── Logs ── */", licensesStart);
		const licensesSource = source.slice(licensesStart, logsStart);
		const normalizedLicensesSource = licensesSource.replace(/\s+/g, " ");

		expect(licensesStart).toBeGreaterThanOrEqual(0);
		expect(logsStart).toBeGreaterThan(licensesStart);
		expect(source).toContain("sm:max-w-[calc(100vw-48px)]");
		expect(source).toContain("lg:max-w-[840px]");
		expect(source).toContain("max-sm:grid max-sm:grid-cols-5");
		expect(source).toContain("max-sm:flex-col");
		expect(source).toContain("max-sm:whitespace-nowrap");
		expect(source).toContain("flex min-h-0 min-w-0 flex-1 flex-col");
		expect(source).toContain("min-h-0 flex-1 overflow-y-auto p-5 scrollbar-none");
		expect(source).toContain('aria-current={section === n.id ? "page" : undefined}');
		expect(licensesSource).toContain("DASHBOARD_LICENSES.map");
		expect(licensesSource).toContain('target="_blank"');
		expect(licensesSource).toContain('rel="noopener noreferrer"');
		expect(normalizedLicensesSource).toContain("all external direct runtime + build dependencies");
		expect(normalizedLicensesSource).toContain("transitive dependency notices are not included");
		expect(normalizedLicensesSource).not.toContain("copyright notices");
	});
});
