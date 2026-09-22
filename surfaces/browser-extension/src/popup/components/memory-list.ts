import type { Memory } from "../../shared/types.js";

function formatTimestamp(iso: string): string {
	const date = new Date(iso);
	const now = new Date();
	const diffMs = now.getTime() - date.getTime();
	const diffMin = Math.floor(diffMs / 60000);
	const diffHr = Math.floor(diffMs / 3600000);
	const diffDays = Math.floor(diffMs / 86400000);

	if (diffMin < 1) return "just now";
	if (diffMin < 60) return `${diffMin}m ago`;
	if (diffHr < 24) return `${diffHr}h ago`;
	if (diffDays < 7) return `${diffDays}d ago`;
	return date.toLocaleDateString();
}

function parseTags(tags: string | readonly string[] | null | undefined): readonly string[] {
	if (!tags) return [];
	if (Array.isArray(tags)) return tags;
	if (typeof tags === "string") {
		return tags
			.split(",")
			.map((t) => t.trim())
			.filter(Boolean);
	}
	return [];
}

function createStateMessage(title: string, body: string, pulsing = false): HTMLElement {
	const wrapper = document.createElement("div");
	wrapper.className = pulsing ? "state-message loading-pulse" : "state-message";

	const titleEl = document.createElement("span");
	titleEl.className = "state-message-title";
	titleEl.textContent = title;
	wrapper.appendChild(titleEl);

	const bodyEl = document.createElement("span");
	bodyEl.className = "state-message-body";
	bodyEl.textContent = body;
	wrapper.appendChild(bodyEl);

	return wrapper;
}

function createMemoryItem(memory: Memory): HTMLElement {
	const item = document.createElement("div");
	item.className = "memory-item";

	const content = document.createElement("div");
	content.className = "memory-content";
	content.textContent = memory.content;
	item.appendChild(content);

	const meta = document.createElement("div");
	meta.className = "memory-meta";
	const time = document.createElement("span");
	time.textContent = formatTimestamp(memory.created_at);
	meta.appendChild(time);
	if (memory.importance > 0) {
		const imp = document.createElement("span");
		imp.className = "memory-importance";
		imp.textContent = `${(memory.importance * 100).toFixed(0)}%`;
		meta.appendChild(imp);
	}
	if (memory.score !== undefined && memory.score > 0) {
		const score = document.createElement("span");
		score.className = "memory-importance";
		score.textContent = `score: ${memory.score.toFixed(2)}`;
		meta.appendChild(score);
	}
	const tags = parseTags(memory.tags);
	for (const tag of tags.slice(0, 3)) {
		const tagEl = document.createElement("span");
		tagEl.className = "memory-tag";
		tagEl.textContent = tag;
		meta.appendChild(tagEl);
	}

	item.appendChild(meta);
	return item;
}

export function renderMemories(container: HTMLElement, memories: readonly Memory[]): void {
	container.replaceChildren();

	if (memories.length === 0) {
		container.appendChild(
			createStateMessage("No memories", "Highlight text on any page and right-click to remember it"),
		);
		return;
	}

	for (const memory of memories) {
		container.appendChild(createMemoryItem(memory));
	}
}

export function renderOffline(container: HTMLElement): void {
	container.replaceChildren(createStateMessage("Daemon offline", "Start the Signet daemon to view memories"));
}

export function renderLoading(container: HTMLElement): void {
	container.replaceChildren(createStateMessage("Loading", "Connecting to daemon...", true));
}

export function renderSearchEmpty(container: HTMLElement, query: string): void {
	container.replaceChildren(createStateMessage("No results", `No memories match "${query}"`));
}
