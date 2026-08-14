export interface TrayInteractionHost<Menu> {
	on(event: "click", listener: () => void): void;
	on(event: "right-click", listener: () => void): void;
	popUpContextMenu(menu: Menu): void;
}

export function bindTrayInteractions<Menu>(
	tray: TrayInteractionHost<Menu>,
	openDashboard: () => void,
	contextMenu: () => Menu | null,
	platform: NodeJS.Platform = process.platform,
): void {
	tray.on("click", openDashboard);
	if (platform !== "darwin") return;
	tray.on("right-click", () => {
		const menu = contextMenu();
		if (menu) tray.popUpContextMenu(menu);
	});
}
