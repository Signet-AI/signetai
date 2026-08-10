import { describe, expect, it } from "bun:test";
import { MarketplaceMcpClientBudget, withMarketplaceMcpTimeout } from "./marketplace-client-budget.js";

describe("MarketplaceMcpClientBudget", () => {
	it("caps active clients and reports stdio process counts", async () => {
		const budget = new MarketplaceMcpClientBudget(2);
		const first = await budget.acquire(100);
		const second = await budget.acquire(100);
		first.markProcessStarted();
		second.markProcessStarted();

		const queued = budget.acquire(1_000);
		await new Promise((resolve) => setTimeout(resolve, 0));
		expect(budget.status()).toEqual({ activeClients: 2, activeProcesses: 2, pending: 1, limit: 2 });

		first.release();
		const third = await queued;
		expect(budget.status()).toEqual({ activeClients: 2, activeProcesses: 1, pending: 0, limit: 2 });

		third.markProcessStarted();
		third.release();
		second.release();
		expect(budget.status()).toEqual({ activeClients: 0, activeProcesses: 0, pending: 0, limit: 2 });
	});

	it("removes timed-out waiters without consuming a later permit", async () => {
		const budget = new MarketplaceMcpClientBudget(1);
		const active = await budget.acquire(100);

		await expect(budget.acquire(10)).rejects.toThrow(/budget timed out/);
		expect(budget.status().pending).toBe(0);

		active.release();
		expect(budget.status()).toEqual({ activeClients: 0, activeProcesses: 0, pending: 0, limit: 1 });
	});

	it("invokes cleanup when an operation reaches its deadline", async () => {
		let closed = false;

		await expect(
			withMarketplaceMcpTimeout(new Promise<never>(() => undefined), 10, "test MCP operation", async () => {
				closed = true;
			}),
		).rejects.toThrow(/test MCP operation timed out/);

		expect(closed).toBe(true);
	});
});
