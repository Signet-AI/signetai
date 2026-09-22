import { checkHealth, getStatus } from "../../shared/api.js";

type HealthState = "healthy" | "degraded" | "offline";

export function initHealthBadge(dot: HTMLElement, versionEl: HTMLElement): () => Promise<void> {
	async function update(): Promise<void> {
		const health = await checkHealth();
		let state: HealthState;

		if (health === null) {
			state = "offline";
			dot.title = "Daemon offline";
			versionEl.textContent = "offline";
		} else if (health.status === "ok" || health.status === "healthy") {
			state = "healthy";
			dot.title = "Daemon healthy";
			const status = await getStatus();
			versionEl.textContent = status?.version ? `v${status.version}` : "connected";
		} else {
			state = "degraded";
			dot.title = `Daemon: ${health.status}`;
			versionEl.textContent = health.status;
		}

		dot.setAttribute("data-state", state);
	}

	return update;
}
