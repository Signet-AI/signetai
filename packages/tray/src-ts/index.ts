import { invoke } from "@tauri-apps/api/core";
import { deriveState, type DaemonState } from "./state";
import { buildTrayUpdate } from "./menu";

const DAEMON_URL = "http://localhost:3850";
const POLL_RUNNING_MS = 5000;
const POLL_STOPPED_MS = 2000;

let lastKind: DaemonState["kind"] = "unknown";

async function updateTray(state: DaemonState): Promise<void> {
  const update = buildTrayUpdate(state);
  await invoke("update_tray", { state: update });
}

async function poll(): Promise<void> {
  const state = await deriveState(DAEMON_URL);

  // Only update tray when state actually changes
  if (state.kind !== lastKind) {
    await updateTray(state);
    lastKind = state.kind;
  } else if (state.kind === "running") {
    // Always update running state (health score can change)
    await updateTray(state);
  }

  const interval =
    state.kind === "running" ? POLL_RUNNING_MS : POLL_STOPPED_MS;

  setTimeout(poll, interval);
}

// Start polling immediately
poll();
