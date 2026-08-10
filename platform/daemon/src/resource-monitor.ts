/**
 * Daemon resource instrumentation for file descriptors and event loop lag.
 */
import { dlopen, ptr } from "bun:ffi";
import { readdirSync, readlinkSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { logger } from "./logger";
import { reportEventLoopLag, tickPressureState } from "./system-pressure";

const pid = process.pid;
const fdDir = `/proc/${pid}/fd`;
const BYTES_PER_MIB = 1024 * 1024;
const RUSAGE_INFO_V4 = 4;
// sizeof(struct rusage_info_v4) per bsd/sys/resource.h (1×u8[16] + 35×u64).
const RUSAGE_INFO_V4_SIZE = 296;
const RUSAGE_INFO_PHYS_FOOTPRINT_OFFSET = 72;
const RUSAGE_INFO_PEAK_PHYS_FOOTPRINT_OFFSET = 240;

export interface PhysicalMemoryUsage {
	readonly current: number;
	readonly peak: number;
}

type PhysicalMemoryReader = () => PhysicalMemoryUsage | null;

interface LibprocHandle {
	readonly symbols: {
		readonly proc_pid_rusage: (pid: number, flavor: number, buffer: ReturnType<typeof ptr>) => number;
	};
}

let libprocHandle: LibprocHandle | null | undefined;

function loadLibproc(): LibprocHandle | null {
	if (libprocHandle !== undefined) return libprocHandle;
	try {
		libprocHandle = dlopen("/usr/lib/libproc.dylib", {
			proc_pid_rusage: {
				args: ["i32", "i32", "ptr"],
				returns: "i32",
			},
		}) as LibprocHandle;
	} catch {
		libprocHandle = null;
	}
	return libprocHandle;
}

/**
 * macOS process.memoryUsage().rss omits driver-backed and compressed memory.
 * proc_pid_rusage reports the same physical-footprint metric used by vmmap.
 */
function readMacOsPhysicalMemory(): PhysicalMemoryUsage | null {
	if (process.platform !== "darwin") return null;
	const libproc = loadLibproc();
	if (!libproc) return null;

	const raw = new Uint8Array(RUSAGE_INFO_V4_SIZE);
	if (libproc.symbols.proc_pid_rusage(pid, RUSAGE_INFO_V4, ptr(raw)) !== 0) return null;

	const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
	return {
		current: Math.round(Number(view.getBigUint64(RUSAGE_INFO_PHYS_FOOTPRINT_OFFSET, true)) / BYTES_PER_MIB),
		peak: Math.round(Number(view.getBigUint64(RUSAGE_INFO_PEAK_PHYS_FOOTPRINT_OFFSET, true)) / BYTES_PER_MIB),
	};
}

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
	physicalFootprint: number | null;
	peakPhysicalFootprint: number | null;
	cpuPercent: number | null;
}

let lastCpuUsage: NodeJS.CpuUsage | null = null;
let lastCpuSampleAt: number | null = null;

function readCpuPercent(): number | null {
	try {
		const now = performance.now();
		const usage = process.cpuUsage();
		const previous = lastCpuUsage;
		const previousAt = lastCpuSampleAt;
		lastCpuUsage = usage;
		lastCpuSampleAt = now;
		if (!previous || previousAt === null) return null;
		const elapsedMs = now - previousAt;
		if (!Number.isFinite(elapsedMs) || elapsedMs <= 0) return null;
		const cpuMicros = Math.max(0, usage.user - previous.user) + Math.max(0, usage.system - previous.system);
		return Math.max(0, Math.min(1000, (cpuMicros / (elapsedMs * 1000)) * 100));
	} catch {
		return null;
	}
}

function snapshotResources(readPhysicalMemory: PhysicalMemoryReader = readMacOsPhysicalMemory): ResourceSnapshot {
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
		physicalFootprint: null,
		peakPhysicalFootprint: null,
		cpuPercent: null,
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
	const physicalMemory = readPhysicalMemory();
	if (physicalMemory) {
		snap.physicalFootprint = physicalMemory.current;
		snap.peakPhysicalFootprint = physicalMemory.peak;
	}
	snap.cpuPercent = readCpuPercent();

	return snap;
}

export function getResourceSnapshot(readPhysicalMemory?: PhysicalMemoryReader): ResourceSnapshot {
	return snapshotResources(readPhysicalMemory);
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
		...(snap.physicalFootprint !== null ? { physicalFootprint: `${snap.physicalFootprint}MB` } : {}),
		...(snap.cpuPercent !== null ? { cpuPercent: `${Math.round(snap.cpuPercent)}%` } : {}),
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
		// Feed the pressure signal so background write loops can yield/pause.
		reportEventLoopLag(lag);
		// Advance the pressure state machine on the monitor's own cadence so
		// reads (isSystemPressureHigh) stay pure and never clear the signal.
		tickPressureState();
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
