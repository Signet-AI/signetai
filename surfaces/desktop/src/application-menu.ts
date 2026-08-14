import type { MenuItemConstructorOptions } from "electron";

export function applicationMenuTemplate(platform: NodeJS.Platform): MenuItemConstructorOptions[] | null {
	if (platform !== "darwin") return null;

	return [{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }];
}
