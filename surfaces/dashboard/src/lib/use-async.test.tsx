import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { Window } from "happy-dom";
import { installDashboardDomGlobals } from "@/test/dom-globals";
import { dashboardQueryCache } from "./query-cache";
import { useAsync } from "./use-async";
let restore = () => {};
const roots: Root[] = [];
beforeAll(() => {
	restore = installDashboardDomGlobals(new Window({ url: "http://localhost" }));
});
afterAll(() => restore());
afterEach(async () => {
	await act(async () => {
		for (const root of roots.splice(0)) root.unmount();
	});
	dashboardQueryCache.clear(false);
	document.body.replaceChildren();
});
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
async function mount(element: React.ReactNode) {
	const container = document.createElement("div");
	document.body.append(container);
	const root = createRoot(container);
	roots.push(root);
	await act(async () => {
		root.render(element);
		await flush();
	});
	return { root, container };
}

test("navigation remount paints the cached snapshot without another daemon read", async () => {
	let reads = 0;
	const fetcher = async () => {
		reads++;
		return { value: "cached graph" };
	};
	function Page() {
		const query = useAsync(fetcher, { key: "graph:48" });
		return <span>{query.loading ? "loading" : query.data?.value}</span>;
	}
	const first = await mount(<Page />);
	await act(async () => first.root.unmount());
	roots.splice(roots.indexOf(first.root), 1);
	const second = await mount(<Page />);
	expect(second.container.textContent).toBe("cached graph");
	expect(reads).toBe(1);
});

test("two mounted consumers share pending reads and receive a forced refresh", async () => {
	let reads = 0;
	let refresh!: () => Promise<void>;
	const fetcher = async () => ({ revision: ++reads });
	function Page({ control = false }: { control?: boolean }) {
		const query = useAsync(fetcher, { key: "shared" });
		if (control) refresh = query.refresh;
		return <span>{query.data?.revision}</span>;
	}
	const first = await mount(<Page control />);
	const second = await mount(<Page />);
	expect(reads).toBe(1);
	await act(async () => {
		await refresh();
	});
	expect(first.container.textContent).toBe("2");
	expect(second.container.textContent).toBe("2");
});

test("changing a query parameter never renders another parameter's cached data", async () => {
	function Page({ id }: { id: string }) {
		const query = useAsync(async () => ({ id }), { key: `entity:${id}` });
		return <span>{query.data?.id ?? "loading"}</span>;
	}
	const page = await mount(<Page id="one" />);
	await act(async () => {
		page.root.render(<Page id="two" />);
		await flush();
	});
	expect(page.container.textContent).toBe("two");
});

test("a slow read cannot accumulate overlapping polls", async () => {
	let reads = 0;
	let release!: (value: string) => void;
	const fetcher = () => {
		reads++;
		return new Promise<string>((resolve) => {
			release = resolve;
		});
	};
	function Page() {
		const query = useAsync(fetcher, { key: "slow", intervalMs: 5 });
		return <span>{query.data ?? "loading"}</span>;
	}
	const page = await mount(<Page />);
	await act(async () => {
		await new Promise((resolve) => setTimeout(resolve, 30));
	});
	expect(reads).toBe(1);
	await act(async () => {
		release("done");
		await flush();
		page.root.unmount();
	});
	roots.splice(roots.indexOf(page.root), 1);
});

test("mutation invalidation keeps a snapshot visible while refreshing only its subscribers", async () => {
	let reads = 0;
	let release!: (value: { revision: number }) => void;
	const fetcher = () =>
		++reads === 1
			? Promise.resolve({ revision: 1 })
			: new Promise<{ revision: number }>((resolve) => {
					release = resolve;
				});
	function Page() {
		const query = useAsync(fetcher, { key: "mutable" });
		return <span>{query.loading ? "loading" : query.data?.revision}</span>;
	}
	const page = await mount(<Page />);
	await act(async () => {
		dashboardQueryCache.invalidate((key) => key.endsWith(":mutable"));
		await flush();
	});
	expect(page.container.textContent).toBe("1");
	expect(reads).toBe(2);
	await act(async () => {
		release({ revision: 2 });
		await flush();
	});
	expect(page.container.textContent).toBe("2");
});
