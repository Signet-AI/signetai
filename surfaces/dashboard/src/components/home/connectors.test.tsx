import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { installDashboardDomGlobals } from "@/test/dom-globals";

let restoreDomGlobals = () => {};
import { ViewProvider } from "@/lib/view-context";
import { ConnectorDetailsRow } from "../settings/connector-details";
import { useState } from "react";
import { act } from "react";
import { type Root, createRoot } from "react-dom/client";
import { HomeConnectorsPanel } from "./connectors";
import {
	api,
	type ApiReadResult,
	type HarnessActionResponse,
	type HarnessConnector,
	type HarnessesResponse,
} from "@/lib/api";

const originalRepair = api.repairHarness;
const originalReinitialize = api.reinitializeHarness;
const originalHealth = api.getHarnessHealth;

function flush(): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, 0));
}

async function mount(element: React.ReactNode): Promise<{ container: HTMLElement; root: Root }> {
	const container = document.createElement("div");
	document.body.appendChild(container);
	const root = createRoot(container);
	await act(async () => {
		root.render(<ViewProvider>{element}</ViewProvider>);
		await flush();
	});
	return { container, root };
}

async function click(element: Element): Promise<void> {
	await act(async () => {
		(element as HTMLElement).click();
		await flush();
		await flush();
	});
}

function requiredButton(container: HTMLElement, selector: string): HTMLButtonElement {
	const element = container.querySelector(selector);
	if (!(element instanceof HTMLButtonElement)) throw new Error(`button not found: ${selector}`);
	return element;
}

function connector(overrides: Partial<HarnessConnector> = {}): HarnessConnector {
	return {
		id: "alpha",
		displayName: "Alpha Harness",
		kind: "harness",
		description: "Harness connector",
		icon: "alpha.svg",
		available: true,
		configured: true,
		detected: true,
		installed: true,
		relevant: true,
		configPath: "/tmp/alpha-config",
		lastSeen: null,
		capabilities: { repair: true, reinitialize: true, reinitializeRequiresConfirmation: true },
		health: { status: "healthy", message: "Integration is ready.", checkedAt: new Date().toISOString() },
		...overrides,
	};
}

function response(connectors: readonly HarnessConnector[]): ApiReadResult<HarnessesResponse> {
	return {
		data: {
			harnesses: [],
			connectors,
			configuredHarnesses: connectors.filter((item) => item.configured).map((item) => item.id),
		},
		error: null,
	};
}

beforeAll(() => {
	const window = new Window({ url: "http://localhost", settings: { enableImageFileLoading: false } });
	restoreDomGlobals = installDashboardDomGlobals(window);
});

afterAll(() => restoreDomGlobals());

afterEach(() => {
	api.repairHarness = originalRepair;
	api.reinitializeHarness = originalReinitialize;
	api.getHarnessHealth = originalHealth;
	document.body.replaceChildren();
});

function RecoveryPanel({
	result,
}: {
	result: ApiReadResult<HarnessesResponse>;
	loading: boolean;
	onRefresh?: () => void;
}) {
	const [busy, setBusy] = useState<string | null>(null);
	return (
		<>
			{result.data?.connectors.map((item) => (
				<ConnectorDetailsRow
					key={item.id}
					connector={item}
					stale={false}
					globallyBusy={busy !== null && busy !== item.id}
					onRunning={(running) => setBusy(running ? item.id : null)}
				/>
			))}
		</>
	);
}

describe("HomeConnectorsPanel", () => {
	test("shows installed connectors and distinguishes concrete problems from unknown health", async () => {
		const mounted = await mount(
			<HomeConnectorsPanel
				result={response([
					connector(),
					connector({
						id: "bravo",
						displayName: "Bravo Harness",
						health: { status: "degraded", message: "Registration missing.", checkedAt: new Date().toISOString() },
					}),
					connector({
						id: "charlie",
						displayName: "Charlie Harness",
						health: { status: "unhealthy", message: "Plugin failed to load.", checkedAt: new Date().toISOString() },
					}),
					connector({
						id: "delta",
						displayName: "Delta Harness",
						health: { status: "needs-auth", message: "Credentials expired.", checkedAt: new Date().toISOString() },
					}),
					connector({
						id: "echo",
						displayName: "Echo Harness",
						health: {
							status: "unknown",
							message: "Integration detected; runtime health has not been verified.",
							checkedAt: new Date().toISOString(),
						},
					}),
					connector({
						id: "ignored",
						displayName: "Ignored Harness",
						relevant: false,
						configured: false,
						detected: false,
						installed: false,
					}),
				])}
				loading={false}
			/>,
		);

		expect(mounted.container.querySelector('[data-testid="connector-count"]')?.textContent).toBe("5");
		expect(mounted.container.textContent).toContain("Alpha Harness");
		expect(mounted.container.textContent).toContain("Bravo Harness");
		expect(mounted.container.textContent).toContain("Sign in needed");
		expect(mounted.container.textContent).toContain("Installed");
		expect(mounted.container.textContent).not.toContain("Ignored Harness");
		expect(mounted.container.querySelector('[aria-label="Reinitialize Alpha Harness"]')).toBeNull();
		expect(mounted.container.querySelector('img[src="/logos/alpha.svg"]')).not.toBeNull();

		await act(async () => mounted.root.unmount());
	});

	test("hides detected and configured harnesses without a Signet installation", async () => {
		const mounted = await mount(
			<HomeConnectorsPanel
				result={response([
					connector({
						id: "pi",
						displayName: "Pi",
						health: { status: "unknown", message: "No runtime probe.", checkedAt: new Date().toISOString() },
					}),
					connector({
						id: "not-installed",
						displayName: "Absent",
						installed: false,
						detected: true,
						configured: true,
						relevant: true,
					}),
				])}
				loading={false}
			/>,
		);
		expect(mounted.container.textContent).toContain("Pi");
		expect(mounted.container.textContent).not.toContain("Absent");
		expect(mounted.container.textContent).not.toContain("Not verified");
		expect(mounted.container.querySelector('[aria-label="Repair Pi"]')).toBeNull();
		await act(async () => mounted.root.unmount());
	});

	test("retains names and logos through request and inspection failures, then removes confirmed uninstallations", async () => {
		const mounted = await mount(<HomeConnectorsPanel result={response([connector()])} loading={false} />);
		const render = async (result: ApiReadResult<HarnessesResponse>) => {
			await act(async () => {
				mounted.root.render(
					<ViewProvider>
						<HomeConnectorsPanel result={result} loading={false} />
					</ViewProvider>,
				);
				await flush();
			});
		};
		await render({ data: null, error: "Request timed out" });
		expect(mounted.container.querySelector('img[src="/logos/alpha.svg"]')).not.toBeNull();
		expect(mounted.container.textContent).toContain("Checks unavailable");
		expect(mounted.container.textContent).toContain("last known installations");
		expect(mounted.container.querySelector('[aria-label="Reinitialize Alpha Harness"]')).toBeNull();
		await render(
			response([
				connector({
					available: false,
					installed: false,
					icon: null,
					displayName: "alpha",
					inspectionStatus: "unavailable",
					health: { status: "unknown", message: "Inspection timed out", checkedAt: new Date().toISOString() },
				}),
			]),
		);
		expect(mounted.container.textContent).toContain("Alpha Harness");
		expect(mounted.container.querySelector('img[src="/logos/alpha.svg"]')).not.toBeNull();
		expect(mounted.container.textContent).not.toContain("Unhealthy");
		await render(response([connector()]));
		expect(mounted.container.textContent).not.toContain("Checks unavailable");
		await render(response([connector({ installed: false })]));
		expect(mounted.container.querySelector("img")).toBeNull();
		expect(mounted.container.textContent).toContain("No Signet connectors installed.");
		await act(async () => mounted.root.unmount());
	});

	test("a cold-start inspection failure cannot invent an installation or an empty success", async () => {
		const mounted = await mount(
			<HomeConnectorsPanel
				result={response([connector({ available: false, installed: false, inspectionStatus: "unavailable" })])}
				loading={false}
			/>,
		);
		expect(mounted.container.textContent).not.toContain("Alpha Harness");
		expect(mounted.container.textContent).not.toContain("No Signet connectors installed.");
		expect(mounted.container.textContent).toContain("could not be checked");
		await act(async () => mounted.root.unmount());
	});

	test("bounds the connector rows in an inner scroll region", async () => {
		const mounted = await mount(<HomeConnectorsPanel result={response([connector()])} loading={false} />);

		const rows = mounted.container.querySelector('[data-testid="connector-rows"]');
		expect(rows).not.toBeNull();
		expect(rows?.classList.contains("overflow-y-auto")).toBe(true);
		expect(rows?.classList.contains("scrollbar-none")).toBe(false);
		expect(rows?.getAttribute("aria-label")).toBe("Installed connectors");

		await act(async () => mounted.root.unmount());
	});

	test("renders a quiet zero-connector state", async () => {
		const mounted = await mount(<HomeConnectorsPanel result={response([])} loading={false} />);

		expect(mounted.container.querySelector('[data-testid="connector-count"]')?.textContent).toBe("0");
		expect(mounted.container.textContent).toContain("No Signet connectors installed.");

		await act(async () => mounted.root.unmount());
	});

	test("shows row progress, disables conflicting actions, refreshes only that row, and reports success", async () => {
		let resolveRepair: ((result: ApiReadResult<HarnessActionResponse>) => void) | undefined;
		let healthCalls = 0;
		const sectionRefreshes = 0;
		api.repairHarness = () => new Promise((resolve) => (resolveRepair = resolve));
		api.getHarnessHealth = async () => {
			healthCalls += 1;
			return {
				data: {
					...connector(),
					health: { status: "healthy", message: "Integration is ready.", checkedAt: new Date().toISOString() },
				},
				error: null,
			};
		};
		const mounted = await mount(
			<RecoveryPanel
				result={response([
					connector({
						health: { status: "degraded", message: "Registration missing.", checkedAt: new Date().toISOString() },
					}),
					connector({
						id: "bravo",
						displayName: "Bravo Harness",
						health: { status: "degraded", message: "Registration missing.", checkedAt: new Date().toISOString() },
					}),
				])}
				loading={false}
			/>,
		);

		await click(requiredButton(mounted.container, '[aria-label="Repair Alpha Harness"]'));
		expect(mounted.container.querySelector('[aria-busy="true"]')).not.toBeNull();
		expect(mounted.container.textContent).toContain("Repairing…");
		expect((mounted.container.querySelector('[aria-label="Repair Alpha Harness"]') as HTMLButtonElement).disabled).toBe(
			true,
		);
		expect((mounted.container.querySelector('[aria-label="Repair Bravo Harness"]') as HTMLButtonElement).disabled).toBe(
			true,
		);

		await act(async () => {
			resolveRepair?.({
				data: { success: true, id: "alpha", action: "repair", message: "Repair completed." },
				error: null,
			});
			await flush();
		});
		expect(healthCalls).toBe(1);
		expect(sectionRefreshes).toBe(0);
		expect(mounted.container.textContent).toContain("Repair completed.");
		expect(mounted.container.querySelector('[aria-busy="true"]')).toBeNull();

		await act(async () => mounted.root.unmount());
	});

	test("requires confirmation for reinitialize and preserves action errors after the health refresh", async () => {
		let reinitializeCalls = 0;
		api.repairHarness = async () => ({ data: null, error: "Registration missing", details: { path: "/tmp/config" } });
		api.reinitializeHarness = async () => {
			reinitializeCalls += 1;
			return {
				data: { success: true, id: "alpha", action: "reinitialize", message: "Reinitialize completed." },
				error: null,
			};
		};
		api.getHarnessHealth = async () => ({
			data: {
				...connector(),
				health: { status: "degraded", message: "Registration missing.", checkedAt: new Date().toISOString() },
			},
			error: null,
		});
		const mounted = await mount(
			<RecoveryPanel
				result={response([
					connector({
						health: { status: "degraded", message: "Registration missing.", checkedAt: new Date().toISOString() },
					}),
				])}
				loading={false}
			/>,
		);

		await click(requiredButton(mounted.container, '[aria-label="Repair Alpha Harness"]'));
		expect(mounted.container.querySelector('[role="alert"]')?.textContent).toBe("Registration missing");

		await click(requiredButton(mounted.container, '[aria-label="Reinitialize Alpha Harness"]'));
		expect(reinitializeCalls).toBe(0);
		expect(mounted.container.textContent).not.toContain("Reinitialize completed.");

		await act(async () => mounted.root.unmount());
	});

	test("invokes reinitialize when the connector marks it safe without confirmation", async () => {
		let reinitializeCalls = 0;
		api.reinitializeHarness = async () => {
			reinitializeCalls += 1;
			return {
				data: { success: true, id: "alpha", action: "reinitialize", message: "Reinitialize completed." },
				error: null,
			};
		};
		api.getHarnessHealth = async () => ({
			data: {
				...connector(),
				health: { status: "healthy", message: "Integration is ready.", checkedAt: new Date().toISOString() },
			},
			error: null,
		});
		const mounted = await mount(
			<RecoveryPanel
				result={response([
					connector({
						capabilities: { repair: true, reinitialize: true, reinitializeRequiresConfirmation: false },
						health: { status: "degraded", message: "Registration missing.", checkedAt: new Date().toISOString() },
					}),
				])}
				loading={false}
			/>,
		);

		await click(requiredButton(mounted.container, '[aria-label="Reinitialize Alpha Harness"]'));
		expect(reinitializeCalls).toBe(1);
		expect(mounted.container.textContent).toContain("Reinitialize completed.");

		await act(async () => mounted.root.unmount());
	});

	test("does not render recovery actions that the connector does not support", async () => {
		const mounted = await mount(
			<RecoveryPanel
				result={response([
					connector({
						capabilities: { repair: true, reinitialize: false, reinitializeRequiresConfirmation: false },
						health: { status: "degraded", message: "Registration missing.", checkedAt: new Date().toISOString() },
					}),
				])}
				loading={false}
			/>,
		);

		expect(mounted.container.querySelector('[aria-label="Repair Alpha Harness"]')).not.toBeNull();
		expect(mounted.container.querySelector('[aria-label="Reinitialize Alpha Harness"]')).toBeNull();

		await act(async () => mounted.root.unmount());
	});
});
