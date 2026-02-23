import { invoke } from "@tauri-apps/api/core";
import {
  fetchHealth,
  fetchMemories,
  fetchDiagnostics,
  fetchEmbeddings,
  buildCurrentState,
  resetState,
  type DaemonState,
} from "./state";
import { buildTrayUpdate, type TrayUpdate } from "./menu";

const DAEMON_URL = "http://localhost:3850";

// Poll intervals (ms)
const HEALTH_RUNNING_MS = 5_000;
const HEALTH_STOPPED_MS = 2_000;
const MEMORIES_MS = 15_000;
const DIAGNOSTICS_MS = 30_000;
const EMBEDDINGS_MS = 60_000;

let lastUpdateJson = "";
let isRunning = false;

async function updateTray(state: DaemonState): Promise<void> {
  const update = buildTrayUpdate(state);
  const json = JSON.stringify(update);

  // Only invoke Rust when something actually changed
  if (json === lastUpdateJson) return;
  lastUpdateJson = json;

  await invoke("update_tray", { state: update });
}

// --- Health polling (primary; determines running vs stopped) ---
async function pollHealth(): Promise<void> {
  const alive = await fetchHealth(DAEMON_URL);

  if (alive && !isRunning) {
    // Just came online – kick off all secondary polls immediately
    isRunning = true;
    fetchMemories(DAEMON_URL);
    fetchDiagnostics(DAEMON_URL);
    fetchEmbeddings(DAEMON_URL);
  } else if (!alive && isRunning) {
    isRunning = false;
    resetState();
  }

  const state = buildCurrentState();
  await updateTray(state);

  const interval = isRunning ? HEALTH_RUNNING_MS : HEALTH_STOPPED_MS;
  setTimeout(pollHealth, interval);
}

// --- Secondary pollers (only run while daemon is alive) ---
async function pollMemories(): Promise<void> {
  if (isRunning) {
    await fetchMemories(DAEMON_URL);
    const state = buildCurrentState();
    await updateTray(state);
  }
  setTimeout(pollMemories, MEMORIES_MS);
}

async function pollDiagnostics(): Promise<void> {
  if (isRunning) {
    await fetchDiagnostics(DAEMON_URL);
    const state = buildCurrentState();
    await updateTray(state);
  }
  setTimeout(pollDiagnostics, DIAGNOSTICS_MS);
}

async function pollEmbeddings(): Promise<void> {
  if (isRunning) {
    await fetchEmbeddings(DAEMON_URL);
    const state = buildCurrentState();
    await updateTray(state);
  }
  setTimeout(pollEmbeddings, EMBEDDINGS_MS);
}

// Start all pollers
pollHealth();
setTimeout(pollMemories, 3_000); // stagger initial fetches
setTimeout(pollDiagnostics, 4_000);
setTimeout(pollEmbeddings, 5_000);
