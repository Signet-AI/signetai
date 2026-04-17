import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("signetDesktop", {
	platform: process.platform,
	daemonPort: Number.parseInt(process.env.SIGNET_PORT ?? "3850", 10),
	nativeFrame: process.env.SIGNET_DESKTOP_NATIVE_FRAME === "1",
	minimize: () => ipcRenderer.invoke("desktop:minimize"),
	toggleMaximize: () => ipcRenderer.invoke("desktop:toggleMaximize"),
	close: () => ipcRenderer.invoke("desktop:close"),
	isMaximized: () => ipcRenderer.invoke("desktop:isMaximized"),
	startDaemon: () => ipcRenderer.invoke("desktop:startDaemon"),
	stopDaemon: () => ipcRenderer.invoke("desktop:stopDaemon"),
	restartDaemon: () => ipcRenderer.invoke("desktop:restartDaemon"),
	getDaemonStatus: () => ipcRenderer.invoke("desktop:getDaemonStatus"),
	openDashboard: () => ipcRenderer.invoke("desktop:openDashboard"),
	quickCapture: (content: string) => ipcRenderer.invoke("desktop:quickCapture", content),
	searchMemories: (query: string, limit?: number) => ipcRenderer.invoke("desktop:searchMemories", query, limit),
	checkForUpdate: () => ipcRenderer.invoke("desktop:checkForUpdate"),
	quit: () => ipcRenderer.invoke("desktop:quit"),
	onWindowStateChange: (callback: (state: { readonly maximized: boolean }) => void) => {
		const listener = (_event: Electron.IpcRendererEvent, state: { readonly maximized: boolean }) => callback(state);
		ipcRenderer.on("desktop:windowState", listener);
		return () => ipcRenderer.off("desktop:windowState", listener);
	},
});
