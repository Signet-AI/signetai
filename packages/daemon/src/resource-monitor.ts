/**
 * Daemon resource instrumentation for file descriptors and event loop lag.
 */
import { readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { logger } from "./logger";

const pid = process.pid;
const fdDir = `/proc/${pid}/fd`;

export interface ResourceSnapshot {
	total: number;
	memoryMd: number;
	sockets: number;
	inotify: number;
	pipes: number;
	db: number;
	other: number;
	rss: number;
	heapUsed: number;
}

function snapshotResources(): ResourceSnapshot {
	const snap: ResourceSnapshot = {
		total: 0,
		memoryMd: 0,
		sockets: 0,
		inotify: 0,
		pipes: 0,
		db: 0,
		other: 0,
		rss: 0,
		heapUsed: 0,
	};

	try {
		const entries = readdirSync(fdDir);
		snap.total = entries.length;

		for (const fd of entries) {
			try {
				const target = readlinkSync(join(fdDir, fd));
				if (target.includes("/memory/") && target.endsWith(".md")) snap.memoryMd++;
				else if (target.startsWith("socket:")) snap.sockets++;
				else if (target.includes("inotify")) snap.inotify++;
				else if (target.startsWith("pipe:")) snap.pipes++;
				else if (target.includes("memories.db")) snap.db++;
				else snap.other++;
			} catch {
				snap.other++;
			}
		}
	} catch {
		snap.total = -1;
	}

	const mem = process.memoryUsage();
	snap.rss = Math.round(mem.rss / 1024 / 1024);
	snap.heapUsed = Math.round(mem.heapUsed / 1024 / 1024);

	return snap;
}

export function getResourceSnapshot(): ResourceSnapshot {
	return snapshotResources();
}

export function logFdSnapshot(stage: string): ResourceSnapshot {
	const snap = snapshotResources();
	logger.info("resources", `[${stage}]`, {
		total: snap.total,
		memoryMd: snap.memoryMd,
		sockets: snap.sockets,
		inotify: snap.inotify,
		pipes: snap.pipes,
		db: snap.db,
		other: snap.other,
		rss: `${snap.rss}MB`,
		heap: `${snap.heapUsed}MB`,
	});
	return snap;
}

let eventLoopTimer: ReturnType<typeof setInterval> | null = null;
let fdPollTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Periodic event loop lag monitor.
 * Fires every 2s, measures how late the callback is.
 * Lag > 100ms means the event loop was blocked.
 */
export function startEventLoopMonitor(intervalMs = 2000): void {
	if (eventLoopTimer) {
		clearInterval(eventLoopTimer);
	}
	let lastTick = Date.now();
	eventLoopTimer = setInterval(() => {
		const now = Date.now();
		const lag = now - lastTick - intervalMs;
		if (lag > 100) {
			logger.warn("resources", "Event loop blocked", {
				lagMs: lag,
				expectedMs: intervalMs,
				actualMs: now - lastTick,
			});
		}
		lastTick = now;
	}, intervalMs);
	// Don't keep process alive just for monitoring
	if (eventLoopTimer.unref) eventLoopTimer.unref();
}

/**
 * Periodic FD count logger. Logs every N seconds.
 * Logs delta from previous snapshot.
 */
export function startFdPollMonitor(intervalMs = 30_000): void {
	if (fdPollTimer) {
		clearInterval(fdPollTimer);
	}
	let prev: ResourceSnapshot | null = null;
	fdPollTimer = setInterval(() => {
		const snap = snapshotResources();
		const delta = prev
			? {
					total: snap.total - prev.total,
					memoryMd: snap.memoryMd - prev.memoryMd,
					sockets: snap.sockets - prev.sockets,
				}
			: null;
		logger.debug("resources", "[periodic]", {
			total: snap.total,
			memoryMd: snap.memoryMd,
			sockets: snap.sockets,
			db: snap.db,
			rss: `${snap.rss}MB`,
			...(delta ? { delta_total: delta.total, delta_memoryMd: delta.memoryMd } : {}),
		});
		prev = snap;
	}, intervalMs);
	if (fdPollTimer.unref) fdPollTimer.unref();
}

export function stopResourceMonitors(): void {
	if (eventLoopTimer) {
		clearInterval(eventLoopTimer);
		eventLoopTimer = null;
	}
	if (fdPollTimer) {
		clearInterval(fdPollTimer);
		fdPollTimer = null;
	}
}
