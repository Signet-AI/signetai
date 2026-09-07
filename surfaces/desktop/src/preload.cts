import { contextBridge, ipcRenderer } from "electron";

const daemonPort = Number.parseInt(process.env.SIGNET_PORT ?? "3850", 10);
const daemonBaseUrl = process.env.SIGNET_DESKTOP_DAEMON_BASE_URL ?? `http://localhost:${daemonPort}`;

contextBridge.exposeInMainWorld("signetDesktop", {
	platform: process.platform,
	daemonPort,
	daemonBaseUrl,
	workspacePath: process.env.SIGNET_PATH ?? process.env.SIGNET_WORKSPACE ?? null,
	startDaemon: () => ipcRenderer.invoke("desktop:startDaemon"),
	stopDaemon: () => ipcRenderer.invoke("desktop:stopDaemon"),
	restartDaemon: () => ipcRenderer.invoke("desktop:restartDaemon"),
	getDaemonStatus: () => ipcRenderer.invoke("desktop:getDaemonStatus"),
	setTitleBarTheme: (theme: "light" | "dark") => ipcRenderer.invoke("desktop:setTitleBarTheme", theme),
	openDashboard: () => ipcRenderer.invoke("desktop:openDashboard"),
	quickCapture: (content: string) => ipcRenderer.invoke("desktop:quickCapture", content),
	searchMemories: (query: string, limit?: number) => ipcRenderer.invoke("desktop:searchMemories", query, limit),
	pickDirectory: (options?: { title?: string }) => ipcRenderer.invoke("desktop:pickDirectory", options),
	checkForUpdate: () => ipcRenderer.invoke("desktop:checkForUpdate"),
	openExternal: (url: string) => ipcRenderer.invoke("desktop:openExternal", url),
	quit: () => ipcRenderer.invoke("desktop:quit"),
});
